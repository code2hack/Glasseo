package com.code2hack.glasseo

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class InputBindingsTest {
    @Test fun qualificationHidMapHasSevenDistinctKeys() {
        val bindings = QualificationHidBindings()
        val keys = listOf(
            KeyEvent.KEYCODE_ENTER,
            KeyEvent.KEYCODE_DEL,
            KeyEvent.KEYCODE_SPACE,
            KeyEvent.KEYCODE_DPAD_LEFT,
            KeyEvent.KEYCODE_DPAD_RIGHT,
            KeyEvent.KEYCODE_DPAD_UP,
            KeyEvent.KEYCODE_DPAD_DOWN,
        )
        assertEquals(SemanticControl.entries.toSet(), keys.mapNotNull(bindings::controlFor).toSet())
        assertNull(bindings.controlFor(KeyEvent.KEYCODE_A))
    }

    @Test fun builtInMapFailsClosedUntilTargetEvidenceQualifiesKeys() {
        assertNull(BuiltInKeyBindings().controlFor(KeyEvent.KEYCODE_ENTER))
    }
}
