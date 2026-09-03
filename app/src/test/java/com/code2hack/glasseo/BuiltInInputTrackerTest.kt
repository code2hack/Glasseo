package com.code2hack.glasseo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BuiltInInputTrackerTest {
    @Test fun backwardCompositeEmitsExactlyOneUpDownUpAndForgivesIntermediates() {
        val tracker = BuiltInInputTracker()
        assertTrue(tracker.handleKey(83, PhysicalAction.DOWN, 0).isEmpty())
        assertTrue(tracker.handleKey(83, PhysicalAction.UP, 1).isEmpty())
        assertEquals(
            listOf(BuiltInControlEvent(SemanticControl.UP, PhysicalAction.DOWN, 2)),
            tracker.handleKey(21, PhysicalAction.DOWN, 2),
        )
        assertTrue(tracker.handleKey(21, PhysicalAction.UP, 3).isEmpty())
        assertTrue(tracker.handleKey(19, PhysicalAction.DOWN, 4).isEmpty())
        assertEquals(
            listOf(BuiltInControlEvent(SemanticControl.UP, PhysicalAction.UP, 5)),
            tracker.handleKey(19, PhysicalAction.UP, 5),
        )
    }

    @Test fun forwardCompositeEmitsExactlyOneDownAndNoDoubleBegin() {
        val tracker = BuiltInInputTracker()
        tracker.handleKey(83, PhysicalAction.DOWN, 0)
        tracker.handleKey(83, PhysicalAction.UP, 1)
        assertEquals(
            listOf(BuiltInControlEvent(SemanticControl.DOWN, PhysicalAction.DOWN, 2)),
            tracker.handleKey(22, PhysicalAction.DOWN, 2),
        )
        assertTrue(tracker.handleKey(22, PhysicalAction.UP, 3).isEmpty())
        assertTrue(tracker.handleKey(20, PhysicalAction.REPEAT, 4).isEmpty())
        assertTrue(tracker.handleKey(20, PhysicalAction.DOWN, 4).isEmpty())
        assertEquals(
            listOf(BuiltInControlEvent(SemanticControl.DOWN, PhysicalAction.UP, 5)),
            tracker.handleKey(20, PhysicalAction.UP, 5),
        )
    }

    @Test fun commandBroadcastsMapThroughClassifierTiming() {
        val tracker = BuiltInInputTracker()
        val short = tracker.handleBroadcast(BuiltInInputTracker.ACTION_SPRITE_BUTTON_UP, 1_000)
        assertEquals(
            listOf(
                BuiltInControlEvent(SemanticControl.COMMAND, PhysicalAction.DOWN, 999),
                BuiltInControlEvent(SemanticControl.COMMAND, PhysicalAction.UP, 1_000),
            ),
            short,
        )
        val long = tracker.handleBroadcast(BuiltInInputTracker.ACTION_SPRITE_BUTTON_LONG_PRESS, 1_000)
        assertEquals(399, long.first().timeMillis)
        assertEquals(1_000, long.last().timeMillis)
        assertTrue(tracker.handleBroadcast("other", 1_000).isEmpty())
    }

    @Test fun cancelDropsIncompleteCompositeAndCancelsEmittedDirection() {
        val tracker = BuiltInInputTracker()
        tracker.handleKey(83, PhysicalAction.DOWN, 0)
        tracker.cancel()
        assertTrue(tracker.handleKey(19, PhysicalAction.UP, 5).isEmpty())

        tracker.handleKey(83, PhysicalAction.DOWN, 0)
        tracker.handleKey(21, PhysicalAction.DOWN, 1)
        assertEquals(
            listOf(BuiltInControlEvent(SemanticControl.UP, PhysicalAction.CANCEL, 2)),
            tracker.handleKey(21, PhysicalAction.CANCEL, 2),
        )
    }
}
