package com.code2hack.glasseo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InputCoreTest {
    private val timing = InputTiming(longPressMillis = 500, doublePressMillis = 300)
    private val hidPrimary = owner(PhysicalSource.HID, 1, 10)
    private val hidSecondary = owner(PhysicalSource.HID, 1, 11)
    private val builtInPrimary = owner(PhysicalSource.BUILT_IN, 2, 10)

    @Test fun vocabularyIsExactlySevenControls() {
        assertEquals(
            listOf("PRIMARY", "SECONDARY", "COMMAND", "LEFT", "RIGHT", "UP", "DOWN"),
            SemanticControl.entries.map { it.name },
        )
    }

    @Test fun classifiesShortLongAndDoubleAtBoundaries() {
        val classifier = InputClassifier(timing)
        assertEquals(listOf(SemanticAction.BEGIN), classifier.handle(down(hidPrimary, SemanticControl.PRIMARY, 0)).actions())
        assertEquals(listOf(SemanticAction.SHORT, SemanticAction.END), classifier.handle(up(hidPrimary, SemanticControl.PRIMARY, 499)).actions())
        assertEquals(listOf(SemanticAction.BEGIN), classifier.handle(down(hidPrimary, SemanticControl.PRIMARY, 1_000)).actions())
        assertEquals(listOf(SemanticAction.LONG), classifier.advance(1_500).actions())
        assertEquals(listOf(SemanticAction.END), classifier.handle(up(hidPrimary, SemanticControl.PRIMARY, 1_600)).actions())

        assertTrue(classifier.handle(down(hidSecondary, SemanticControl.SECONDARY, 2_000)).isEmpty())
        assertTrue(classifier.handle(up(hidSecondary, SemanticControl.SECONDARY, 2_100)).isEmpty())
        assertTrue(classifier.handle(down(hidSecondary, SemanticControl.SECONDARY, 2_400)).isEmpty())
        assertEquals(listOf(SemanticAction.DOUBLE), classifier.handle(up(hidSecondary, SemanticControl.SECONDARY, 2_450)).actions())
    }

    @Test fun longSecondaryCannotBecomeDouble() {
        val classifier = InputClassifier(timing)
        classifier.handle(down(hidSecondary, SemanticControl.SECONDARY, 0))
        classifier.handle(up(hidSecondary, SemanticControl.SECONDARY, 100))
        classifier.handle(down(hidSecondary, SemanticControl.SECONDARY, 200))
        assertEquals(listOf(SemanticAction.LONG), classifier.advance(700).actions())
        assertEquals(listOf(SemanticAction.END), classifier.handle(up(hidSecondary, SemanticControl.SECONDARY, 750)).actions())
    }

    @Test fun enforcesOneOwnerAndIgnoresLateUpAfterCancellation() {
        val classifier = InputClassifier(timing)
        classifier.handle(down(hidPrimary, SemanticControl.PRIMARY, 0))
        assertTrue(classifier.handle(down(builtInPrimary, SemanticControl.PRIMARY, 10)).isEmpty())
        assertEquals(listOf(SemanticAction.CANCEL), classifier.cancelAll(20).actions())
        assertTrue(classifier.handle(up(hidPrimary, SemanticControl.PRIMARY, 30)).isEmpty())
        assertEquals(listOf(SemanticAction.BEGIN), classifier.handle(down(builtInPrimary, SemanticControl.PRIMARY, 40)).actions())
    }

    @Test fun deduplicatesRepeatedDownAndRepresentsDirectionalHold() {
        val classifier = InputClassifier(timing)
        val direction = owner(PhysicalSource.HID, 1, 12)
        assertEquals(listOf(SemanticAction.BEGIN), classifier.handle(down(direction, SemanticControl.UP, 0)).actions())
        assertEquals(listOf(SemanticAction.UPDATE), classifier.handle(repeat(direction, SemanticControl.UP, 20)).actions())
        assertEquals(listOf(SemanticAction.END), classifier.handle(up(direction, SemanticControl.UP, 30)).actions())
        classifier.handle(down(hidPrimary, SemanticControl.PRIMARY, 40))
        assertTrue(classifier.handle(repeat(hidPrimary, SemanticControl.PRIMARY, 50)).isEmpty())
    }

    @Test fun disconnectCancelsOnlyItsSourceAndReconnectStartsCleanly() {
        val classifier = InputClassifier(timing)
        classifier.handle(down(hidPrimary, SemanticControl.PRIMARY, 0))
        assertTrue(classifier.cancelSource(PhysicalSource.BUILT_IN, 2, 10).isEmpty())
        assertEquals(listOf(SemanticAction.CANCEL), classifier.cancelSource(PhysicalSource.HID, 1, 20).actions())
        assertEquals(listOf(SemanticAction.BEGIN), classifier.handle(down(hidPrimary, SemanticControl.PRIMARY, 30)).actions())
    }

    @Test fun hudDoubleHideAndWakeConsumesWholeControl() {
        val visibility = mutableListOf<Boolean>()
        val controller = HudInputController(InputClassifier(timing), visibility::add)
        controller.handle(down(hidSecondary, SemanticControl.SECONDARY, 0))
        controller.handle(up(hidSecondary, SemanticControl.SECONDARY, 50))
        controller.handle(down(hidSecondary, SemanticControl.SECONDARY, 100))
        val hiddenEvents = controller.handle(up(hidSecondary, SemanticControl.SECONDARY, 150))
        assertTrue(controller.isHidden)
        assertTrue(hiddenEvents.isEmpty())
        assertEquals(listOf(false), visibility)

        assertTrue(controller.handle(down(hidPrimary, SemanticControl.PRIMARY, 200)).isEmpty())
        assertTrue(controller.handle(up(hidPrimary, SemanticControl.PRIMARY, 250)).isEmpty())
        assertFalse(controller.isHidden)
        assertEquals(listOf(false, true), visibility)
        assertNull(controller.nextDeadlineMillis)
    }

    private fun owner(source: PhysicalSource, deviceId: Int, code: Int) = PhysicalOwner(source, deviceId, code)
    private fun down(owner: PhysicalOwner, control: SemanticControl, time: Long) = PhysicalInput(owner, control, PhysicalAction.DOWN, time)
    private fun repeat(owner: PhysicalOwner, control: SemanticControl, time: Long) = PhysicalInput(owner, control, PhysicalAction.REPEAT, time)
    private fun up(owner: PhysicalOwner, control: SemanticControl, time: Long) = PhysicalInput(owner, control, PhysicalAction.UP, time)
    private fun List<SemanticInteraction>.actions() = map { it.action }
}
