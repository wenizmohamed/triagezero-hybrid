package com.triagezero.field

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StartTriageEngineTest {
    @Test
    fun walkingWoundedIsMinorGreen() {
        val verdict = StartTriageEngine.evaluate(
            PatientVitals(
                canWalk = true, breathing = true, airwayOpenedBreathing = true,
                respRate = 20, capRefillSec = 1.0, radialPulse = true, obeysCommands = true
            )
        )
        assertEquals(StartCategory.GREEN, verdict.category)
    }

    @Test
    fun apneicEvenAfterAirwayIsExpectantBlack() {
        val verdict = StartTriageEngine.evaluate(
            PatientVitals(
                canWalk = false, breathing = false, airwayOpenedBreathing = false,
                respRate = 0, capRefillSec = 5.0, radialPulse = false, obeysCommands = false
            )
        )
        assertEquals(StartCategory.BLACK, verdict.category)
    }

    @Test
    fun apneicResumingAfterJawThrustIsImmediateRed() {
        val verdict = StartTriageEngine.evaluate(
            PatientVitals(
                canWalk = false, breathing = false, airwayOpenedBreathing = true,
                respRate = 14, capRefillSec = 1.8, radialPulse = true, obeysCommands = true
            )
        )
        assertEquals(StartCategory.RED, verdict.category)
    }

    @Test
    fun remoteConfigCustomRespThresholdChangesVerdict() {
        val vitals = PatientVitals(
            canWalk = false, breathing = true, airwayOpenedBreathing = true,
            respRate = 35, capRefillSec = 1.5, radialPulse = true, obeysCommands = true
        )
        assertEquals(StartCategory.RED, StartTriageEngine.evaluate(vitals, ClinicalThresholds(respRateMax = 30)).category)
        assertEquals(StartCategory.YELLOW, StartTriageEngine.evaluate(vitals, ClinicalThresholds(respRateMax = 40)).category)
    }

    @Test
    fun sha256HashChainAndTamperDetectionWork() {
        val built = mutableListOf<OfflineCasualtyRecord>()
        for (p in StartTriageEngine.PRELOADED_CASES) {
            built += StartTriageEngine.appendToChain(built, p, p.vitals, ClinicalThresholds(), "on_device")
        }
        assertTrue(StartTriageEngine.verifyChain(built))

        val tampered = built.mapIndexed { idx, rec ->
            if (idx == 2) rec.copy(verdict = rec.verdict.copy(category = StartCategory.GREEN)) else rec
        }
        assertFalse(StartTriageEngine.verifyChain(tampered))
    }

    @Test
    fun firestoreTagContainsZeroPhi() {
        val first = StartTriageEngine.PRELOADED_CASES.first()
        val rec = StartTriageEngine.appendToChain(emptyList(), first, first.vitals, ClinicalThresholds(), "on_device")
        val payload = StartTriageEngine.toZeroPhiFirestoreTag(rec)
        assertEquals("android", payload["platform"])
        assertFalse(payload.containsKey("patientName"))
        assertFalse(payload.containsKey("mechanism"))
        assertFalse(payload.containsKey("clinicalNotes"))
    }
}
