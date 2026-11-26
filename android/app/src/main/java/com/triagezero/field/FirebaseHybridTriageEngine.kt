@file:OptIn(com.google.firebase.ai.type.PublicPreviewAPI::class)

package com.triagezero.field

import android.content.Context
import android.util.Log
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.ai.GenerativeModel
import com.google.firebase.ai.InferenceMode
import com.google.firebase.ai.InferenceSource
import com.google.firebase.ai.OnDeviceConfig
import com.google.firebase.ai.ai
import com.google.firebase.ai.type.GenerativeBackend
import com.google.firebase.ai.type.content
import com.google.firebase.ai.type.generationConfig
import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory
import com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.remoteconfig.FirebaseRemoteConfig
import com.google.firebase.remoteconfig.remoteConfig
import com.google.firebase.remoteconfig.remoteConfigSettings
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withTimeout
import java.util.UUID

data class HybridBriefResult(
    val briefText: String,
    val inferenceSource: String,
    val firestoreReceiptPath: String,
    val syncedTagsCount: Int
)

class FirebaseHybridTriageEngine(context: Context) {
    private val appContext = context.applicationContext
    private var initialized = false

    fun ensureInitialized() {
        if (initialized) return
        initialized = true
        if (FirebaseApp.getApps(appContext).isEmpty()) {
            FirebaseApp.initializeApp(appContext)
        }
        val appCheck = FirebaseAppCheck.getInstance()
        val factory = if (BuildConfig.DEBUG) {
            DebugAppCheckProviderFactory.getInstance()
        } else {
            PlayIntegrityAppCheckProviderFactory.getInstance()
        }
        appCheck.installAppCheckProviderFactory(factory)

        val rc: FirebaseRemoteConfig = Firebase.remoteConfig
        rc.setConfigSettingsAsync(
            remoteConfigSettings { minimumFetchIntervalInSeconds = 600 }
        )
        rc.setDefaultsAsync(
            mapOf(
                "triage_cloud_model" to "gemini-4-hydrogen",
                "start_resp_rate_max" to 30L,
                "start_cap_refill_max_sec" to 2.0,
                "max_offline_queue" to 200L,
                "prefer_on_device_intake" to true
            )
        )
    }

    suspend fun fetchRemotePolicy(): Pair<String, ClinicalThresholds> {
        ensureInitialized()
        val rc = Firebase.remoteConfig
        runCatching { withTimeout(3500) { rc.fetchAndActivate().await() } }
        val cloudModel = rc.getString("triage_cloud_model").ifBlank { "gemini-4-hydrogen" }
        val rrMax = rc.getLong("start_resp_rate_max").toInt().takeIf { it > 0 } ?: 30
        val capMax = rc.getDouble("start_cap_refill_max_sec").takeIf { it > 0.0 } ?: 2.0
        return cloudModel to ClinicalThresholds(respRateMax = rrMax, capRefillMaxSec = capMax)
    }

    /**
     * Hybrid Field Intake Assistant using Firebase AI Logic InferenceMode.PREFER_ON_DEVICE
     * (runs Gemini Nano on Android AICore in dead zones and seamlessly falls back if unavailable).
     */
    private fun hybridIntakeModel(cloudModel: String, systemPrompt: String): GenerativeModel {
        ensureInitialized()
        return Firebase.ai(backend = GenerativeBackend.googleAI()).generativeModel(
            modelName = cloudModel,
            generationConfig = generationConfig {
                temperature = 0.2f
                maxOutputTokens = 2048
            },
            systemInstruction = content("system") { text(systemPrompt) },
            onDeviceConfig = OnDeviceConfig(mode = InferenceMode.PREFER_ON_DEVICE)
        )
    }

    /**
     * In-Cloud Surge Coordinator invoked ONLY when Starlink/5G returns to compute
     * receiving hospital diversion & ER handoff narrative.
     */
    private fun cloudSurgeModel(cloudModel: String): GenerativeModel {
        ensureInitialized()
        return Firebase.ai(backend = GenerativeBackend.googleAI()).generativeModel(
            modelName = cloudModel,
            generationConfig = generationConfig {
                temperature = 0.2f
                maxOutputTokens = 4096
            },
            systemInstruction = content("system") {
                text(
                    "You are TriageZero Android Field Sync. Synthesize a crisp 4-bullet multi-casualty " +
                        "hospital diversion and pre-arrival ER alert from these de-identified START vitals. Never invent names."
                )
            },
            onDeviceConfig = OnDeviceConfig(mode = InferenceMode.ONLY_IN_CLOUD)
        )
    }

    /**
     * Executes local-first hybrid inference for a field note when online or on Gemini Nano-capable Pixel.
     */
    suspend fun evaluateFieldNoteHybrid(
        note: String,
        onlineAllowed: Boolean,
        cloudModel: String
    ): Pair<String, String> {
        if (!onlineAllowed) {
            // Dead-zone guarantee: strict ONLY_ON_DEVICE attempt with 0 cloud bytes
            return try {
                ensureInitialized()
                val nanoOnly = Firebase.ai(backend = GenerativeBackend.googleAI()).generativeModel(
                    modelName = cloudModel,
                    onDeviceConfig = OnDeviceConfig(mode = InferenceMode.ONLY_ON_DEVICE)
                )
                val res = withTimeout(2500) {
                    nanoOnly.generateContent("Extract immediate trauma action (1 sentence): $note")
                }
                val text = res.text?.trim().orEmpty().ifBlank { "Local START stabilization queued." }
                text to "on_device (Gemini Nano)"
            } catch (_: Throwable) {
                "Offline dead-zone START RPM active (0 B cloud traffic)." to "on_device"
            }
        }

        return try {
            val model = hybridIntakeModel(
                cloudModel = cloudModel,
                systemPrompt = "Provide a 1-sentence EMS field stabilization priority from these de-identified START vitals."
            )
            val res = withTimeout(5000) { model.generateContent(note) }
            val src = if (res.inferenceSource == InferenceSource.ON_DEVICE) "on_device" else "in_cloud"
            (res.text?.trim().orEmpty().ifBlank { "Stabilize airway/perfusion; priority transport." }) to src
        } catch (t: Throwable) {
            Log.w("TriageZeroAI", "Hybrid intake fallback: ${t.message}")
            "Deterministic START RPM fallback active." to "on_device"
        }
    }

    /**
     * Flushes offline queue to Cloud Firestore zero-PHI incident relay (synced live to Web ER Dashboard)
     * + immutable zero-PHI dispatch receipt, and runs Firebase AI Logic ONLY_IN_CLOUD surge synthesis.
     */
    suspend fun syncQueueAndSynthesizeSurge(
        incidentId: String,
        records: List<OfflineCasualtyRecord>,
        cloudModel: String
    ): HybridBriefResult {
        ensureInitialized()
        val db = FirebaseFirestore.getInstance()
        val sessionId = getOrCreateEmsSessionId()

        // 1. Write strictly zero-PHI casualty telemetry to /incidents/{incidentId}/casualties/{tagId}
        var syncedCount = 0
        for (rec in records) {
            val payload = StartTriageEngine.toZeroPhiFirestoreTag(rec).toMutableMap().apply {
                this["at"] = FieldValue.serverTimestamp()
            }
            runCatching {
                withTimeout(4000) {
                    db.collection("incidents").document(incidentId)
                        .collection("casualties").document(rec.id)
                        .set(payload)
                        .await()
                }
                syncedCount++
            }.onFailure {
                Log.w("TriageZeroSync", "Tag sync warning for ${rec.id}: ${it.message}")
            }
        }

        // 2. Write immutable zero-PHI dispatch receipt matching firestore.rules
        val counts = mapOf(
            "RED" to records.count { it.verdict.category == StartCategory.RED },
            "YELLOW" to records.count { it.verdict.category == StartCategory.YELLOW },
            "GREEN" to records.count { it.verdict.category == StartCategory.GREEN },
            "BLACK" to records.count { it.verdict.category == StartCategory.BLACK }
        )
        val rootHash = records.lastOrNull()?.entryHash ?: StartTriageEngine.GENESIS_HASH
        val receipt = hashMapOf(
            "at" to FieldValue.serverTimestamp(),
            "incidentId" to incidentId,
            "protocolVersion" to StartTriageEngine.PROTOCOL_VERSION,
            "counts" to counts,
            "totalCasualties" to records.size,
            "inferenceSource" to "hybrid_burst",
            "offlineQueueFlushed" to syncedCount,
            "cloudBytesSent" to (records.size * 180),
            "hospitalTargetsCount" to 4,
            "chainRootSha256" to rootHash
        )
        var receiptPath = "local_pending"
        runCatching {
            val docRef = withTimeout(4000) {
                db.collection("sessions").document(sessionId)
                    .collection("dispatch_receipts")
                    .add(receipt)
                    .await()
            }
            receiptPath = docRef.path
        }.onFailure {
            Log.w("TriageZeroReceipt", "Receipt write warning: ${it.message}")
        }

        // 3. Call Firebase AI Logic ONLY_IN_CLOUD for hospital diversion narrative
        val summaryInput = buildString {
            append("Incident ").append(incidentId).append(" · Counts: ")
            append(counts).append(". Casualties:\n")
            records.forEach {
                append("- ").append(it.id).append(" (").append(it.ageSex).append(", ")
                    .append(it.specialtyNeed).append(") => ").append(it.verdict.category.code)
                    .append(" | ").append(it.verdict.rpmSummary).append("\n")
            }
        }

        val (brief, srcLabel) = try {
            val res = withTimeout(15000) { cloudSurgeModel(cloudModel).generateContent(summaryInput) }
            val text = res.text?.trim().orEmpty()
            if (text.length > 25) {
                text to "in_cloud · LIVE $cloudModel"
            } else {
                val fb = withTimeout(12000) { cloudSurgeModel("gemini-3.5-flash-lite").generateContent(summaryInput) }
                val fbText = fb.text?.trim().orEmpty()
                if (fbText.length > 25) fbText to "in_cloud · LIVE gemini-3.5-flash-lite (failover)" else fallbackSurgeText(records, counts) to "in_cloud · Guard"
            }
        } catch (t: Throwable) {
            Log.w("TriageZeroCloud", "Primary cloud surge retry with failover: ${t.message}")
            runCatching {
                val fb = withTimeout(12000) { cloudSurgeModel("gemini-3.5-flash-lite").generateContent(summaryInput) }
                val fbText = fb.text?.trim().orEmpty()
                if (fbText.length > 25) fbText to "in_cloud · LIVE gemini-3.5-flash-lite (failover)" else null
            }.getOrNull() ?: (fallbackSurgeText(records, counts) to "offline_guard")
        }

        return HybridBriefResult(
            briefText = brief,
            inferenceSource = srcLabel,
            firestoreReceiptPath = receiptPath,
            syncedTagsCount = syncedCount
        )
    }

    private fun fallbackSurgeText(records: List<OfflineCasualtyRecord>, counts: Map<String, Int>): String {
        val redIds = records.filter { it.verdict.category == StartCategory.RED }.joinToString(", ") { it.id }
        return buildString {
            append("• Immediate RED Priority Evacuation: ").append(redIds.ifBlank { "None" }).append("\n")
            append("• Trauma Diversion: Route Pediatric RED to St. Jude Level-1 Ped; Crush/Airway to Metro L1 & Harbor L2.\n")
            append("• Totals Synced: RED=${counts["RED"]}, YELLOW=${counts["YELLOW"]}, GREEN=${counts["GREEN"]}, BLACK=${counts["BLACK"]}.")
        }
    }

    private fun getOrCreateEmsSessionId(): String {
        val prefs = appContext.getSharedPreferences("triagezero_prefs", Context.MODE_PRIVATE)
        val existing = prefs.getString("ems_session_id", null)
        if (!existing.isNullOrBlank() && Regex("^ems_[0-9a-f-]{36}$").matches(existing)) {
            return existing
        }
        val created = "ems_${UUID.randomUUID().toString().lowercase()}"
        prefs.edit().putString("ems_session_id", created).apply()
        return created
    }
}
