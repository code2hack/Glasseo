package com.code2hack.glasseo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BroadcastInterceptionTest {
    @Test fun onlyOrderedAbortableDeliveryAttemptsCancellation() {
        val state = BroadcastInterceptionState(noAbortFlag = 0x08000000)
        state.begin(QualificationStep.LONG_PRIMARY, setOf("ordered", "normal"))

        assertTrue(state.receive("ordered", flags = 0, ordered = true).abortAttempted)
        assertFalse(state.receive("normal", flags = 0, ordered = false).abortAttempted)
        assertFalse(state.receive("ordered", flags = 0x08000000, ordered = true).abortAttempted)
    }

    @Test fun registrationIsStepScopedAndEndsCleanly() {
        val state = BroadcastInterceptionState()
        state.begin(QualificationStep.LEFT, setOf("left"))
        assertTrue(state.registered)
        assertEquals(setOf("left"), state.actions)

        state.end()
        assertFalse(state.registered)
        assertTrue(state.actions.isEmpty())
        assertFalse(state.receive("left", flags = 0, ordered = true).observed)
    }

    @Test fun persistentOrderedInterceptionSurvivesWizardAndActivityLifecycle() {
        val state = PersistentOrderedBroadcastState(setOf("long-command", "long-primary", "short-command"))

        assertFalse(state.initialized)
        assertTrue(state.initialize())
        assertTrue(state.initialized)
        assertFalse(state.initialize())
        val inStep = state.receive("long-command", flags = 0, ordered = true, QualificationStep.LONG_COMMAND)!!
        assertTrue(inStep.abortAttempted)
        assertEquals(QualificationStep.LONG_COMMAND, inStep.wizardStep)
        assertTrue(state.receive("long-command", flags = 0, ordered = true, QualificationStep.UP)!!.abortAttempted)
        val outsideWizard = state.receive("long-command", flags = 0, ordered = true, null)!!
        assertTrue(outsideWizard.abortAttempted)
        assertEquals(null, outsideWizard.wizardStep)
        assertTrue(state.receive("long-primary", flags = 0, ordered = true, null)!!.abortAttempted)
        assertTrue(state.receive("short-command", flags = 0, ordered = true, null)!!.abortAttempted)
        assertFalse(state.receive("unknown", flags = 0, ordered = true, null)!!.observed)
        assertFalse(state.receive("long-command", flags = 0, ordered = false, null)!!.abortAttempted)
        assertFalse(state.receive("long-command", flags = 0x08000000, ordered = true, null)!!.abortAttempted)

        val restartedProcess = PersistentOrderedBroadcastState(setOf("long-command"))
        assertTrue(restartedProcess.initialize())
        assertTrue(restartedProcess.receive("long-command", 0, true, null)!!.abortAttempted)
    }

    @Test fun persistentReceiverUsesTheExactSupportedOrderedControlAllowlist() {
        assertEquals(
            setOf(
                "com.android.action.ACTION_AI_START",
                "com.android.action.ACTION_SPRITE_BUTTON_UP",
                "com.android.action.ACTION_SPRITE_BUTTON_LONG_PRESS",
            ),
            GlasseoApplication.ORDERED_CONTROL_ACTIONS,
        )
    }

    @Test fun persistentOrderedInterceptionRemainsAbortableWhileQualificationIsPaused() {
        val session = QualificationSession(
            QualificationMode.BUILT_IN,
            sessionId = "paused-session",
            startIndex = QualificationStep.UP.ordinal,
            nowMillis = { 10_000L },
            pauseAt = QualificationPauseTarget(QualificationStep.UP, QualificationPhase.AWAITING_FIRST),
        )
        session.acknowledge(
            QualificationRenderAck(
                session.snapshot.sessionId,
                session.snapshot.revision,
                session.snapshot.step.ordinal,
                session.snapshot.phase,
            ),
        )
        val pausedRevision = session.snapshot.revision
        val state = PersistentOrderedBroadcastState(GlasseoApplication.ORDERED_CONTROL_ACTIONS)
        state.initialize()

        val observation = state.receive(
            "com.android.action.ACTION_SPRITE_BUTTON_LONG_PRESS",
            flags = 0x50000010,
            ordered = true,
            wizardStep = session.snapshot.step,
        )!!

        assertTrue(session.snapshot.paused)
        assertFalse(session.armed)
        assertTrue(observation.abortAttempted)
        assertEquals(QualificationStep.UP, observation.wizardStep)
        assertEquals(pausedRevision, session.snapshot.revision)
    }
}
