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

    @Test fun acknowledgedTargetPausesUntilTheResumedRevisionIsAcknowledged() {
        val pausedSession = QualificationSession(
            QualificationMode.BUILT_IN,
            sessionId = "paused-session",
            startIndex = QualificationStep.UP.ordinal,
            pauseAt = QualificationPauseTarget(QualificationStep.UP, QualificationPhase.AWAITING_FIRST),
            nowMillis = clock::now,
        )
        val targetAck = pausedSession.snapshot.ack()

        val pause = pausedSession.acknowledge(targetAck)

        assertTrue(pause.accepted)
        assertTrue(pause.snapshotChanged)
        assertTrue(pausedSession.snapshot.paused)
        assertFalse(pausedSession.armed)
        assertEquals(targetAck.revision + 1, pausedSession.snapshot.revision)
        val pausedRevision = pausedSession.snapshot.revision
        assertEquals(
            "paused",
            (pausedSession.capture(operation(BehaviorClass.DIRECTIONAL, "up")) as CaptureAdmission.Ignored).reason,
        )

        pausedSession.suspendCapture()
        val replay = pausedSession.acknowledge(pausedSession.snapshot.ack())
        assertTrue(replay.accepted)
        assertFalse(replay.snapshotChanged)
        assertFalse(replay.armed)
        assertEquals(pausedRevision, pausedSession.snapshot.revision)

        assertTrue(pausedSession.resume())
        assertFalse(pausedSession.snapshot.paused)
        assertFalse(pausedSession.armed)
        assertEquals(pausedRevision + 1, pausedSession.snapshot.revision)
        assertFalse(pausedSession.acknowledge(targetAck).accepted)
        assertTrue(pausedSession.acknowledge(pausedSession.snapshot.ack()).armed)
        assertTrue(
            pausedSession.capture(operation(BehaviorClass.DIRECTIONAL, "up")) is CaptureAdmission.Accepted,
        )
    }

    @Test fun finalStepConfirmedCanBeAnAcknowledgedPauseTarget() {
        val finalSession = QualificationSession(
            QualificationMode.BUILT_IN,
            sessionId = "final-session",
            startIndex = QualificationStep.RIGHT.ordinal,
            nowMillis = clock::now,
            pauseAt = QualificationPauseTarget(QualificationStep.RIGHT, QualificationPhase.STEP_CONFIRMED),
        )
        val right = operation(BehaviorClass.DIRECTIONAL, "right")
        finalSession.acknowledge(finalSession.snapshot.ack())
        val first = finalSession.capture(right) as CaptureAdmission.Accepted
        clock.advance(1_200)
        assertTrue(finalSession.finalize(first.token))
        finalSession.acknowledge(finalSession.snapshot.ack())
        val second = finalSession.capture(right) as CaptureAdmission.Accepted
        clock.advance(1_200)
        assertTrue(finalSession.finalize(second.token))
        assertTrue(finalSession.snapshot.complete)
        assertEquals(QualificationPhase.STEP_CONFIRMED, finalSession.snapshot.phase)

        val targetRevision = finalSession.snapshot.revision
        val pause = finalSession.acknowledge(finalSession.snapshot.ack())

        assertTrue(pause.snapshotChanged)
        assertTrue(finalSession.snapshot.paused)
        assertFalse(finalSession.armed)
        assertEquals(targetRevision + 1, finalSession.snapshot.revision)
    }

    @Test fun nonFinalStepConfirmedPausesBeforeAdvancing() {
        val pausedSession = QualificationSession(
            QualificationMode.BUILT_IN,
            sessionId = "confirmed-session",
            startIndex = QualificationStep.SHORT_COMMAND.ordinal,
            nowMillis = clock::now,
            pauseAt = QualificationPauseTarget(
                QualificationStep.LONG_COMMAND,
                QualificationPhase.STEP_CONFIRMED,
            ),
        )
        pausedSession.acknowledge(pausedSession.snapshot.ack())
        val first = pausedSession.capture(shortCommand()) as CaptureAdmission.Accepted
        clock.advance(1_200)
        assertTrue(pausedSession.finalize(first.token))
        pausedSession.acknowledge(pausedSession.snapshot.ack())
        val second = pausedSession.capture(shortCommand()) as CaptureAdmission.Accepted
        clock.advance(1_200)
        assertTrue(pausedSession.finalize(second.token))

        val targetRevision = pausedSession.snapshot.revision
        val pause = pausedSession.acknowledge(pausedSession.snapshot.ack())

        assertTrue(pause.snapshotChanged)
        assertEquals(QualificationStep.LONG_COMMAND, pausedSession.snapshot.step)
        assertEquals(QualificationPhase.STEP_CONFIRMED, pausedSession.snapshot.phase)
        assertTrue(pausedSession.snapshot.paused)
        assertEquals(targetRevision + 1, pausedSession.snapshot.revision)
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
