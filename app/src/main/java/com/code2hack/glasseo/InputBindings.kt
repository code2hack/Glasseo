package com.code2hack.glasseo

import android.view.KeyEvent

interface HidBindingProvider {
    fun controlFor(keyCode: Int): SemanticControl?
}

class QualificationHidBindings : HidBindingProvider {
    private val bindings = mapOf(
        KeyEvent.KEYCODE_ENTER to SemanticControl.PRIMARY,
        KeyEvent.KEYCODE_DEL to SemanticControl.SECONDARY,
        KeyEvent.KEYCODE_SPACE to SemanticControl.COMMAND,
        KeyEvent.KEYCODE_DPAD_LEFT to SemanticControl.LEFT,
        KeyEvent.KEYCODE_DPAD_RIGHT to SemanticControl.RIGHT,
        KeyEvent.KEYCODE_DPAD_UP to SemanticControl.UP,
        KeyEvent.KEYCODE_DPAD_DOWN to SemanticControl.DOWN,
    )

    override fun controlFor(keyCode: Int): SemanticControl? = bindings[keyCode]
}

class BuiltInKeyBindings(
    private val bindings: Map<Int, SemanticControl> = emptyMap(),
) {
    fun controlFor(keyCode: Int): SemanticControl? = bindings[keyCode]
}
