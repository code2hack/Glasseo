package com.code2hack.glasseo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class InputCaptureTest {
    @Test fun multiChannelSignatureIgnoresTimestampsButPreservesOrderedShape() {
        val first = capture(100)
        val second = capture(8_000)

        assertEquals(first, second)
        assertNotEquals(first, second.copy(keys = second.keys.reversed()))
    }

    @Test fun recognizerMatchesOnlyTheCompleteStepScopedOperation() {
        val signature = capture(100)
        val recognizer = BuiltInOperationRecognizer()
        recognizer.qualify(QualificationStep.SHORT_PRIMARY, signature)

        assertEquals(QualificationStep.SHORT_PRIMARY, recognizer.recognize(signature))
        assertNull(recognizer.recognize(signature.copy(keys = signature.keys.take(1))))
        assertThrows(IllegalArgumentException::class.java) {
            recognizer.qualify(QualificationStep.SHORT_COMMAND, signature)
        }
    }

    private fun capture(start: Long): BuiltInOperationSignature {
        val capture = InputCapture(BehaviorClass.SHORT)
        capture.recordKey(83, 204, CapturedKeyPhase.DOWN, start)
        capture.recordKey(83, 204, CapturedKeyPhase.UP, start + 20)
        capture.recordMotion("touch", 0, 2, 4098, 90f, 40f, start + 30)
        capture.recordMotion("touch", 2, 2, 4098, 40f, 41f, start + 35)
        capture.recordMotion("touch", 2, 2, 4098, 20f, 40f, start + 36)
        capture.recordMotion("touch", 1, 2, 4098, 10f, 40f, start + 40)
        capture.recordBroadcast("com.rokid.SECONDARY", 0x40000000, false, start + 50)
        return capture.finish(
            focusLost = false,
            lifecycleEffects = setOf("resumed"),
            systemSideEffects = setOf("tap-tone"),
        )
    }
}
