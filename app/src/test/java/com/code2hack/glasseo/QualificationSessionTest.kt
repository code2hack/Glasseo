package com.code2hack.glasseo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class QualificationSessionTest {
    private val clock = FakeClock()
    private val session = QualificationSession(
        QualificationMode.BUILT_IN,
        sessionId = "session-1",
        startIndex = QualificationStep.SHORT_COMMAND.ordinal,
        nowMillis = clock::now,
    )

    @Test fun shortCommandAndLongCommandAdvanceThroughVisibleSettlesToUp() {
        acknowledgeCurrent()

        captureAndSettle(shortCommand())
        assertSnapshot(QualificationStep.SHORT_COMMAND, QualificationPhase.AWAITING_CONFIRMATION, attempt = 1)
        acknowledgeCurrent()

        captureAndSettle(shortCommand())
        assertSnapshot(QualificationStep.LONG_COMMAND, QualificationPhase.STEP_CONFIRMED, attempt = 2)
        session.acknowledge(session.snapshot.ack())
        assertSnapshot(QualificationStep.LONG_COMMAND, QualificationPhase.AWAITING_FIRST, attempt = 0)
        acknowledgeCurrent()

        captureAndSettle(longCommand())
        assertSnapshot(QualificationStep.LONG_COMMAND, QualificationPhase.AWAITING_CONFIRMATION, attempt = 1)
        acknowledgeCurrent()

        captureAndSettle(longCommand())
        assertSnapshot(QualificationStep.UP, QualificationPhase.STEP_CONFIRMED, attempt = 2)
        session.acknowledge(session.snapshot.ack())
        assertSnapshot(QualificationStep.UP, QualificationPhase.AWAITING_FIRST, attempt = 0)
    }

    @Test fun settleAndUnacknowledgedSnapshotsAcceptExactlyOneOperation() {
        val initialRevision = session.snapshot.revision
        assertEquals("snapshot-unacknowledged", (session.capture(shortCommand()) as CaptureAdmission.Ignored).reason)
        assertEquals(initialRevision, session.snapshot.revision)

        acknowledgeCurrent()
        val accepted = session.capture(shortCommand()) as CaptureAdmission.Accepted
        val settlingRevision = session.snapshot.revision
        assertEquals(QualificationPhase.SETTLING_FIRST, session.snapshot.phase)
        assertEquals("Captured — checking…", session.snapshot.prompt)
        assertEquals("settling", (session.capture(shortCommand()) as CaptureAdmission.Ignored).reason)
        assertEquals(settlingRevision, session.snapshot.revision)
        assertEquals(1, session.snapshot.attempt)

        assertFalse(session.finalize(accepted.token))
        clock.advance(1_200)
        assertTrue(session.finalize(accepted.token))
        assertEquals("snapshot-unacknowledged", (session.capture(shortCommand()) as CaptureAdmission.Ignored).reason)
        assertEquals(1, session.snapshot.attempt)
    }

    @Test fun staleAcksAndFinalizersCannotMutateCurrentStep() {
        val staleAck = session.snapshot.ack().copy(revision = session.snapshot.revision - 1)
        assertFalse(session.acknowledge(staleAck).accepted)
        assertFalse(session.armed)
        acknowledgeCurrent()

        val first = session.capture(shortCommand()) as CaptureAdmission.Accepted
        clock.advance(1_200)
        assertTrue(session.finalize(first.token))
        val confirmationRevision = session.snapshot.revision
        assertFalse(session.finalize(first.token))
        assertEquals(confirmationRevision, session.snapshot.revision)
        assertEquals(QualificationStep.SHORT_COMMAND, session.snapshot.step)

        acknowledgeCurrent()
        val second = session.capture(shortCommand()) as CaptureAdmission.Accepted
        clock.advance(1_200)
        assertTrue(session.finalize(second.token))
        assertEquals(QualificationStep.LONG_COMMAND, session.snapshot.step)
        val longCommandRevision = session.snapshot.revision
        assertFalse(session.finalize(first.token))
        assertEquals(longCommandRevision, session.snapshot.revision)
        assertEquals(QualificationStep.LONG_COMMAND, session.snapshot.step)
    }

    private fun captureAndSettle(operation: QualificationOperation) {
        val accepted = session.capture(operation) as CaptureAdmission.Accepted
        assertTrue(session.snapshot.phase == QualificationPhase.SETTLING_FIRST ||
            session.snapshot.phase == QualificationPhase.SETTLING_SECOND)
        assertFalse(session.armed)
        clock.advance(1_200)
        assertTrue(session.finalize(accepted.token))
    }

    private fun acknowledgeCurrent() {
        session.acknowledge(session.snapshot.ack())
        assertTrue(session.armed)
    }

    private fun assertSnapshot(step: QualificationStep, phase: QualificationPhase, attempt: Int) {
        assertEquals(step, session.snapshot.step)
        assertEquals(phase, session.snapshot.phase)
        assertEquals(attempt, session.snapshot.attempt)
    }

    private fun QualificationSnapshot.ack() = QualificationRenderAck(sessionId, revision, step.ordinal, phase)

    private fun shortCommand() = operation(BehaviorClass.SHORT, "com.android.action.ACTION_SPRITE_BUTTON_UP")
    private fun longCommand() = operation(BehaviorClass.LONG, "com.android.action.ACTION_SPRITE_BUTTON_LONG_PRESS")

    private fun operation(behavior: BehaviorClass, action: String) = QualificationOperation(
        BuiltInOperationSignature(
            behavior,
            emptyList(),
            emptyList(),
            listOf(CapturedBroadcast(action, 0x50000010, true)),
            false,
            emptySet(),
            emptySet(),
        ),
        suppression = SuppressionOutcome.SUCCEEDED,
    )

    private class FakeClock {
        private var millis = 10_000L
        fun now() = millis
        fun advance(delta: Long) { millis += delta }
    }
}
