package com.code2hack.glasseo

import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

class ProbeStateTest {
    @Before fun reset() = ProbeState.reset()

    @Test fun resetClearsRendererLossAndRecordedState() {
        ProbeState.recordRendererGone()
        ProbeState.recordBlockedNavigation()

        ProbeState.reset()

        assertEquals(0, ProbeState.rendererGone)
        assertEquals(0, ProbeState.blockedNavigations)
    }

    @Test fun rendererLossIsCounted() {
        ProbeState.recordRendererGone()
        assertEquals(1, ProbeState.rendererGone)
    }
}
