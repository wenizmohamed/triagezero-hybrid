package com.triagezero.field

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private lateinit var engine: FirebaseHybridTriageEngine

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT)
        )
        engine = FirebaseHybridTriageEngine(this)
        engine.ensureInitialized()

        setContent {
            MaterialTheme {
                TriageZeroFieldScreen(engine = engine)
            }
        }
    }
}

@Composable
fun TriageZeroFieldScreen(engine: FirebaseHybridTriageEngine) {
    val scope = rememberCoroutineScope()
    val incidentId = "INC-TZ26-001"

    var isOnline by remember { mutableStateOf(false) }
    var cloudModel by remember { mutableStateOf("gemini-4-hydrogen") }
    var thresholds by remember { mutableStateOf(ClinicalThresholds()) }

    var selectedPreset by remember { mutableStateOf(StartTriageEngine.PRELOADED_CASES.first()) }
    var canWalk by remember { mutableStateOf(selectedPreset.vitals.canWalk) }
    var breathing by remember { mutableStateOf(selectedPreset.vitals.breathing) }
    var airwayOpened by remember { mutableStateOf(selectedPreset.vitals.airwayOpenedBreathing) }
    var respRate by remember { mutableFloatStateOf(selectedPreset.vitals.respRate.toFloat()) }
    var capRefill by remember { mutableFloatStateOf(selectedPreset.vitals.capRefillSec.toFloat()) }
    var radialPulse by remember { mutableStateOf(selectedPreset.vitals.radialPulse) }
    var obeysCommands by remember { mutableStateOf(selectedPreset.vitals.obeysCommands) }

    var queue by remember { mutableStateOf(listOf<OfflineCasualtyRecord>()) }
    var statusText by remember { mutableStateOf("OFFLINE DEAD ZONE · 0 B cloud traffic · Ready for local START triage.") }
    var surgeBrief by remember { mutableStateOf("") }
    var surgeSource by remember { mutableStateOf("STANDBY (OFFLINE)") }
    var busy by remember { mutableStateOf(false) }

    fun loadPreset(p: FieldCasePreset) {
        selectedPreset = p
        canWalk = p.vitals.canWalk
        breathing = p.vitals.breathing
        airwayOpened = p.vitals.airwayOpenedBreathing
        respRate = p.vitals.respRate.toFloat()
        capRefill = p.vitals.capRefillSec.toFloat()
        radialPulse = p.vitals.radialPulse
        obeysCommands = p.vitals.obeysCommands
    }

    val currentVitals = PatientVitals(
        canWalk = canWalk,
        breathing = breathing,
        airwayOpenedBreathing = airwayOpened,
        respRate = respRate.toInt(),
        capRefillSec = String.format("%.1f", capRefill).toDouble(),
        radialPulse = radialPulse,
        obeysCommands = obeysCommands
    )
    val liveVerdict = StartTriageEngine.evaluate(currentVitals, thresholds)

    val (bgCat, borderCat, fgCat) = when (liveVerdict.category) {
        StartCategory.RED -> Triple(Color(0xFFFEF2F2), Color(0xFFDC2626), Color(0xFFB91C1C))
        StartCategory.YELLOW -> Triple(Color(0xFFFFFBEB), Color(0xFFD97706), Color(0xFFB45309))
        StartCategory.GREEN -> Triple(Color(0xFFF0FDF4), Color(0xFF16A34A), Color(0xFF15803D))
        StartCategory.BLACK -> Triple(Color(0xFFF1F5F9), Color(0xFF1E293B), Color(0xFF0F172A))
    }

    Surface(modifier = Modifier.fillMaxSize(), color = Color(0xFFF8FAFC)) {
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .padding(horizontal = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            item {
                // Header + Connectivity Switch
                Card(
                    colors = CardDefaults.cardColors(containerColor = Color(0xFF0F172A)),
                    shape = RoundedCornerShape(14.dp),
                    modifier = Modifier.padding(top = 8.dp)
                ) {
                    Column(modifier = Modifier.padding(14.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    "TriageZero Android EMT",
                                    color = Color.White,
                                    fontWeight = FontWeight.ExtraBold,
                                    fontSize = 18.sp
                                )
                                Text(
                                    "Firebase AI Logic · PREFER_ON_DEVICE <-> ONLY_IN_CLOUD",
                                    color = Color(0xFF94A3B8),
                                    fontSize = 11.sp
                                )
                            }
                            Switch(
                                checked = isOnline,
                                onCheckedChange = { next ->
                                    isOnline = next
                                    if (next) {
                                        statusText = "SIGNAL RESTORED: Syncing Remote Config & ready for Cloud Surge + Web Relay..."
                                        scope.launch {
                                            val (m, th) = engine.fetchRemotePolicy()
                                            cloudModel = m
                                            thresholds = th
                                        }
                                    } else {
                                        statusText = "OFFLINE DEAD ZONE: 0 B cloud traffic · Gemini Nano / START RPM local."
                                    }
                                }
                            )
                        }
                        Spacer(modifier = Modifier.height(8.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            AssistChip(
                                onClick = {},
                                label = {
                                    Text(
                                        if (isOnline) "ONLINE · $cloudModel" else "OFFLINE · 0 B CLOUD",
                                        fontSize = 10.5.sp,
                                        maxLines = 1,
                                        fontWeight = FontWeight.Bold,
                                        color = if (isOnline) Color(0xFF86EFAC) else Color(0xFFFDE68A)
                                    )
                                }
                            )
                            AssistChip(
                                onClick = {},
                                label = {
                                    Text(
                                        "SHA-256 Chain (${queue.size})",
                                        fontSize = 10.5.sp,
                                        maxLines = 1,
                                        fontFamily = FontFamily.Monospace,
                                        color = Color.White
                                    )
                                }
                            )
                        }
                    }
                }
            }

            item {
                // Preloaded Emergency Scenarios
                Row(
                    modifier = Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    StartTriageEngine.PRELOADED_CASES.forEach { preset ->
                        FilterChip(
                            selected = selectedPreset.id == preset.id,
                            onClick = { loadPreset(preset) },
                            label = { Text(preset.shortLabel, fontSize = 12.sp, fontWeight = FontWeight.SemiBold) }
                        )
                    }
                }
            }

            item {
                // Live START Verdict Card
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(bgCat, RoundedCornerShape(14.dp))
                        .border(2.dp, borderCat, RoundedCornerShape(14.dp))
                        .padding(14.dp)
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            "${liveVerdict.category.label} — ${liveVerdict.category.code}",
                            color = fgCat,
                            fontWeight = FontWeight.ExtraBold,
                            fontSize = 20.sp
                        )
                        Text(
                            liveVerdict.category.transportWindow,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 11.sp,
                            color = fgCat
                        )
                    }
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(liveVerdict.reason, fontSize = 13.sp, color = Color(0xFF0F172A), fontWeight = FontWeight.Medium)
                    Spacer(modifier = Modifier.height(6.dp))
                    Text(liveVerdict.rpmSummary, fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = Color(0xFF475569))
                }
            }

            item {
                // Vital Controls
                Card(colors = CardDefaults.cardColors(containerColor = Color.White), shape = RoundedCornerShape(14.dp)) {
                    Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("Field Vitals (${selectedPreset.id} · ${selectedPreset.ageSex})", fontWeight = FontWeight.Bold, fontSize = 14.sp)
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            Text("Can Walk?", fontSize = 13.sp); Switch(checked = canWalk, onCheckedChange = { canWalk = it })
                            Text("Breathing?", fontSize = 13.sp); Switch(checked = breathing, onCheckedChange = { breathing = it })
                        }
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            Text("Radial Pulse?", fontSize = 13.sp); Switch(checked = radialPulse, onCheckedChange = { radialPulse = it })
                            Text("Obeys Cmds?", fontSize = 13.sp); Switch(checked = obeysCommands, onCheckedChange = { obeysCommands = it })
                        }
                        Text("Respiratory Rate: ${respRate.toInt()} /min (START max ${thresholds.respRateMax})", fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        Slider(value = respRate, onValueChange = { respRate = it }, valueRange = 0f..50f)
                        Text("Capillary Refill: ${String.format("%.1f", capRefill)} s (START max ${thresholds.capRefillMaxSec}s)", fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        Slider(value = capRefill, onValueChange = { capRefill = it }, valueRange = 0.5f..5.0f)

                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(
                                modifier = Modifier.weight(1f),
                                enabled = !busy,
                                onClick = {
                                    busy = true
                                    scope.launch {
                                        val (nanoNote, src) = engine.evaluateFieldNoteHybrid(
                                            "${selectedPreset.title}: ${liveVerdict.rpmSummary}",
                                            onlineAllowed = isOnline,
                                            cloudModel = cloudModel
                                        )
                                        val updated = queue.filterNot { it.id == selectedPreset.id }
                                        val nextRec = StartTriageEngine.appendToChain(updated, selectedPreset, currentVitals, thresholds, src, nanoNote)
                                        queue = updated + nextRec
                                        statusText = "Tagged ${nextRec.id} [${nextRec.verdict.category.code}] ($src): $nanoNote"
                                        busy = false
                                    }
                                }
                            ) {
                                Text("Tag Offline", fontSize = 12.sp, maxLines = 1)
                            }
                            Button(
                                modifier = Modifier.weight(1f),
                                enabled = !busy,
                                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFDC2626)),
                                onClick = {
                                    busy = true
                                    scope.launch {
                                        val built = mutableListOf<OfflineCasualtyRecord>()
                                        for (p in StartTriageEngine.PRELOADED_CASES) {
                                            built += StartTriageEngine.appendToChain(built, p, p.vitals, thresholds, "on_device")
                                        }
                                        queue = built
                                        isOnline = true
                                        val res = engine.syncQueueAndSynthesizeSurge(incidentId, built, cloudModel)
                                        queue = built.map { it.copy(synced = true) }
                                        surgeBrief = res.briefText
                                        surgeSource = res.inferenceSource
                                        statusText = "6-Patient Batch Synced (${res.syncedTagsCount} tags live -> Web ER Dashboard) · ${res.firestoreReceiptPath}"
                                        busy = false
                                    }
                                }
                            ) {
                                Text("6-Patient Surge", fontSize = 12.sp, maxLines = 1)
                            }
                        }

                        if (queue.isNotEmpty()) {
                            OutlinedButton(
                                modifier = Modifier.fillMaxWidth(),
                                enabled = !busy,
                                onClick = {
                                    busy = true
                                    isOnline = true
                                    scope.launch {
                                        val res = engine.syncQueueAndSynthesizeSurge(incidentId, queue, cloudModel)
                                        queue = queue.map { it.copy(synced = true) }
                                        surgeBrief = res.briefText
                                        surgeSource = res.inferenceSource
                                        statusText = "Synced ${res.syncedTagsCount} Android tag(s) -> Chrome ER Workbench ($incidentId)"
                                        busy = false
                                    }
                                }
                            ) {
                                Text("Sync Queued Tags to Cloud & Chrome ER Workbench")
                            }
                        }
                        Text(statusText, fontSize = 12.sp, color = Color(0xFF166534), fontWeight = FontWeight.Medium)
                    }
                }
            }

            if (surgeBrief.isNotBlank()) {
                item {
                    Card(colors = CardDefaults.cardColors(containerColor = Color(0xFFEFF6FF)), shape = RoundedCornerShape(14.dp)) {
                        Column(modifier = Modifier.padding(14.dp)) {
                            Text("Cloud Surge Brief ($surgeSource)", fontWeight = FontWeight.Bold, color = Color(0xFF1D4ED8), fontSize = 13.sp)
                            Spacer(modifier = Modifier.height(6.dp))
                            Text(
                                surgeBrief.replace("**", "").replace("* ", "• "),
                                fontSize = 12.5.sp,
                                color = Color(0xFF0F172A)
                            )
                        }
                    }
                }
            }

            items(queue, key = { it.id }) { rec ->
                Card(colors = CardDefaults.cardColors(containerColor = Color.White), shape = RoundedCornerShape(10.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(12.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text("${rec.id} · ${rec.title} (${rec.ageSex})", fontWeight = FontWeight.Bold, fontSize = 13.sp)
                            Text(rec.verdict.rpmSummary, fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = Color(0xFF475569))
                            if (rec.aiNote.isNotBlank()) {
                                Text("AI Intake: ${rec.aiNote}", fontSize = 11.sp, color = Color(0xFF0F172A))
                            }
                            Text(
                                "sha256:${rec.entryHash.take(12)} · ${rec.inferenceSource} · ${if (rec.synced) "SYNCED" else "OFFLINE"}",
                                fontFamily = FontFamily.Monospace,
                                fontSize = 10.5.sp,
                                color = if (rec.synced) Color(0xFF15803D) else Color(0xFFB45309)
                            )
                        }
                        Badge(
                            containerColor = when (rec.verdict.category) {
                                StartCategory.RED -> Color(0xFFDC2626)
                                StartCategory.YELLOW -> Color(0xFFD97706)
                                StartCategory.GREEN -> Color(0xFF16A34A)
                                StartCategory.BLACK -> Color(0xFF1E293B)
                            }
                        ) {
                            Text(rec.verdict.category.code, color = Color.White, modifier = Modifier.padding(4.dp))
                        }
                    }
                }
            }

            item { Spacer(modifier = Modifier.height(16.dp)) }
        }
    }
}
