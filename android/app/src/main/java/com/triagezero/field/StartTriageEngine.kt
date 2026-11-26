package com.triagezero.field

import java.security.MessageDigest

enum class StartCategory(val code: String, val label: String, val priority: Int, val transportWindow: String) {
    RED("RED", "IMMEDIATE", 1, "Immediate (< 15 min)"),
    YELLOW("YELLOW", "DELAYED", 2, "Delayed (30-60 min)"),
    GREEN("GREEN", "MINOR", 3, "Ambulatory / Surge Bus"),
    BLACK("BLACK", "EXPECTANT", 4, "On-Scene Staging")
}

data class ClinicalThresholds(
    val respRateMax: Int = 30,
    val capRefillMaxSec: Double = 2.0
)

data class PatientVitals(
    val canWalk: Boolean,
    val breathing: Boolean,
    val airwayOpenedBreathing: Boolean = false,
    val respRate: Int,
    val capRefillSec: Double,
    val radialPulse: Boolean,
    val obeysCommands: Boolean
)

data class TriageVerdict(
    val category: StartCategory,
    val reason: String,
    val rpmSummary: String,
    val interventions: List<String>
)

data class FieldCasePreset(
    val id: String,
    val shortLabel: String,
    val title: String,
    val ageSex: String,
    val pediatric: Boolean,
    val specialtyNeed: String,
    val vitals: PatientVitals
)

data class OfflineCasualtyRecord(
    val id: String,
    val title: String,
    val ageSex: String,
    val pediatric: Boolean,
    val specialtyNeed: String,
    val vitals: PatientVitals,
    val verdict: TriageVerdict,
    val inferenceSource: String,
    val prevHash: String,
    val entryHash: String,
    val synced: Boolean = false,
    val aiNote: String = ""
)

object StartTriageEngine {
    const val PROTOCOL_VERSION = "START-v2026"
    val GENESIS_HASH = "0".repeat(64)

    val PRELOADED_CASES = listOf(
        FieldCasePreset(
            id = "EQ-01",
            shortLabel = "EQ-01 Crush",
            title = "Earthquake Crush Injury",
            ageSex = "38M",
            pediatric = false,
            specialtyNeed = "crush_trauma",
            vitals = PatientVitals(
                canWalk = false, breathing = true, airwayOpenedBreathing = true,
                respRate = 34, capRefillSec = 3.5, radialPulse = false, obeysCommands = true
            )
        ),
        FieldCasePreset(
            id = "HWY-02",
            shortLabel = "HWY-02 Pediatric",
            title = "Highway Pediatric Trauma",
            ageSex = "9F",
            pediatric = true,
            specialtyNeed = "pediatric_trauma",
            vitals = PatientVitals(
                canWalk = false, breathing = true, airwayOpenedBreathing = true,
                respRate = 28, capRefillSec = 2.0, radialPulse = true, obeysCommands = false
            )
        ),
        FieldCasePreset(
            id = "SMK-03",
            shortLabel = "SMK-03 Smoke",
            title = "Smoke Inhalation Moderate",
            ageSex = "44F",
            pediatric = false,
            specialtyNeed = "burn_inhalation",
            vitals = PatientVitals(
                canWalk = false, breathing = true, airwayOpenedBreathing = true,
                respRate = 24, capRefillSec = 1.5, radialPulse = true, obeysCommands = true
            )
        ),
        FieldCasePreset(
            id = "WLK-04",
            shortLabel = "WLK-04 Walking",
            title = "Walking Wounded",
            ageSex = "27M",
            pediatric = false,
            specialtyNeed = "minor_urgent",
            vitals = PatientVitals(
                canWalk = true, breathing = true, airwayOpenedBreathing = true,
                respRate = 18, capRefillSec = 1.0, radialPulse = true, obeysCommands = true
            )
        ),
        FieldCasePreset(
            id = "APN-05",
            shortLabel = "APN-05 Apneic",
            title = "Apneic Unresponsive",
            ageSex = "62M",
            pediatric = false,
            specialtyNeed = "expectant",
            vitals = PatientVitals(
                canWalk = false, breathing = false, airwayOpenedBreathing = false,
                respRate = 0, capRefillSec = 5.0, radialPulse = false, obeysCommands = false
            )
        ),
        FieldCasePreset(
            id = "MVA-06",
            shortLabel = "MVA-06 Airway",
            title = "Bus Rollover Airway Rescue",
            ageSex = "51F",
            pediatric = false,
            specialtyNeed = "airway_trauma",
            vitals = PatientVitals(
                canWalk = false, breathing = false, airwayOpenedBreathing = true,
                respRate = 14, capRefillSec = 2.5, radialPulse = true, obeysCommands = false
            )
        )
    )

    fun evaluate(vitals: PatientVitals, thresholds: ClinicalThresholds = ClinicalThresholds()): TriageVerdict {
        val rpm = "R:${vitals.respRate}/m · Cap:${String.format("%.1f", vitals.capRefillSec)}s · ${if (vitals.radialPulse) "Pulse+" else "NoPulse"} · ${if (vitals.obeysCommands) "Obeys" else "Unresp"}"

        if (vitals.canWalk) {
            return TriageVerdict(
                category = StartCategory.GREEN,
                reason = "Ambulatory casualty able to clear hazard zone independently.",
                rpmSummary = rpm,
                interventions = listOf("Direct to minor muster zone", "Superficial wound dressing")
            )
        }

        if (!vitals.breathing) {
            return if (vitals.airwayOpenedBreathing) {
                TriageVerdict(
                    category = StartCategory.RED,
                    reason = "Apneic initially; spontaneous breathing resumed after jaw-thrust airway maneuver.",
                    rpmSummary = rpm,
                    interventions = listOf("Maintain OPA / airway", "Immediate Level-1 airway transport")
                )
            } else {
                TriageVerdict(
                    category = StartCategory.BLACK,
                    reason = "Apneic after two manual airway repositioning attempts.",
                    rpmSummary = rpm,
                    interventions = listOf("Preserve resuscitation bays for survivable RED", "Expectant comfort care")
                )
            }
        }

        if (vitals.respRate > thresholds.respRateMax) {
            return TriageVerdict(
                category = StartCategory.RED,
                reason = "Tachypnea ${vitals.respRate}/min exceeds START threshold (> ${thresholds.respRateMax}/min).",
                rpmSummary = rpm,
                interventions = listOf("High-flow O2", "Chest decompression prep", "Priority Trauma Bay 1")
            )
        }

        if (!vitals.radialPulse || vitals.capRefillSec > thresholds.capRefillMaxSec) {
            val perfReason = if (!vitals.radialPulse) {
                "Absent radial pulse signaling hypoperfusion / hemorrhagic shock."
            } else {
                "Delayed capillary refill ${vitals.capRefillSec}s (> ${thresholds.capRefillMaxSec}s)."
            }
            return TriageVerdict(
                category = StartCategory.RED,
                reason = perfReason,
                rpmSummary = rpm,
                interventions = listOf("Hemorrhage control", "Large-bore IV access / blood bank alert")
            )
        }

        if (!vitals.obeysCommands) {
            return TriageVerdict(
                category = StartCategory.RED,
                reason = "Fails to obey simple commands; acute neurological compromise.",
                rpmSummary = rpm,
                interventions = listOf("Cervical spine immobilization", "Rapid Neuro/Trauma evacuation")
            )
        }

        return TriageVerdict(
            category = StartCategory.YELLOW,
            reason = "Non-ambulatory with stable R-P-M vitals (RR ${vitals.respRate}/m, intact pulse, obeys).",
            rpmSummary = rpm,
            interventions = listOf("Splint extremity", "Reassess RPM q15m", "Delayed transport")
        )
    }

    fun sha256Hex(input: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    fun appendToChain(
        existing: List<OfflineCasualtyRecord>,
        preset: FieldCasePreset,
        vitals: PatientVitals,
        thresholds: ClinicalThresholds,
        inferenceSource: String,
        aiNote: String = ""
    ): OfflineCasualtyRecord {
        val verdict = evaluate(vitals, thresholds)
        val prevHash = existing.lastOrNull()?.entryHash ?: GENESIS_HASH
        val canonical = listOf(
            prevHash,
            preset.id,
            verdict.category.code,
            vitals.respRate.toString(),
            vitals.capRefillSec.toString(),
            vitals.radialPulse.toString(),
            vitals.obeysCommands.toString(),
            inferenceSource
        ).joinToString("|")
        val entryHash = sha256Hex(canonical)
        return OfflineCasualtyRecord(
            id = preset.id,
            title = preset.title,
            ageSex = preset.ageSex,
            pediatric = preset.pediatric,
            specialtyNeed = preset.specialtyNeed,
            vitals = vitals,
            verdict = verdict,
            inferenceSource = inferenceSource,
            prevHash = prevHash,
            entryHash = entryHash,
            synced = false,
            aiNote = aiNote
        )
    }

    fun verifyChain(records: List<OfflineCasualtyRecord>): Boolean {
        var expectedPrev = GENESIS_HASH
        for (r in records) {
            if (r.prevHash != expectedPrev) return false
            val canonical = listOf(
                r.prevHash,
                r.id,
                r.verdict.category.code,
                r.vitals.respRate.toString(),
                r.vitals.capRefillSec.toString(),
                r.vitals.radialPulse.toString(),
                r.vitals.obeysCommands.toString(),
                r.inferenceSource
            ).joinToString("|")
            if (r.entryHash != sha256Hex(canonical)) return false
            expectedPrev = r.entryHash
        }
        return true
    }

    /** Strictly zero-PHI map matching firestore.rules /incidents/{incidentId}/casualties/{tagId}. */
    fun toZeroPhiFirestoreTag(record: OfflineCasualtyRecord): Map<String, Any> = mapOf(
        "id" to record.id,
        "ageSex" to record.ageSex,
        "pediatric" to record.pediatric,
        "specialtyNeed" to record.specialtyNeed,
        "category" to record.verdict.category.code,
        "priority" to record.verdict.category.priority,
        "respRate" to record.vitals.respRate,
        "capRefillSec" to record.vitals.capRefillSec,
        "radialPulse" to record.vitals.radialPulse,
        "obeysCommands" to record.vitals.obeysCommands,
        "canWalk" to record.vitals.canWalk,
        "breathing" to record.vitals.breathing,
        "airwayOpenedBreathing" to record.vitals.airwayOpenedBreathing,
        "inferenceSource" to if (record.inferenceSource.contains("cloud", ignoreCase = true)) "in_cloud" else "on_device",
        "entryHash" to record.entryHash,
        "platform" to "android"
    )
}
