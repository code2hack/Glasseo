package com.code2hack.glasseo

data class BuiltInControlEvent(
    val control: SemanticControl,
    val action: PhysicalAction,
    val timeMillis: Long,
)

/**
 * Maps accepted #3 built-in RG operations to semantic physical inputs.
 *
 * UP/DOWN arrive as a three-key composite (KEY_DASHBOARD + two arrows), each key
 * down/up, and COMMAND arrives as an ordered sprite-button broadcast. Both enter
 * the same InputClassifier used by HID so classification stays after mapping.
 */
class BuiltInInputTracker(private val longPressMillis: Long = 600) {
    private data class Composite(
        val control: SemanticControl?,
        val seen: MutableSet<Int>,
        val emitted: Boolean,
    )

    private var composite: Composite? = null

    fun handleKey(
        keyCode: Int,
        action: PhysicalAction,
        timeMillis: Long,
    ): List<BuiltInControlEvent> = when (action) {
        PhysicalAction.CANCEL -> {
            val current = composite
            composite = null
            if (current?.emitted == true && current.control != null)
                listOf(BuiltInControlEvent(current.control, PhysicalAction.CANCEL, timeMillis))
            else emptyList()
        }
        PhysicalAction.DOWN, PhysicalAction.REPEAT, PhysicalAction.UP ->
            keyPhase(keyCode, action, timeMillis)
    }

    fun handleBroadcast(action: String, timeMillis: Long): List<BuiltInControlEvent> = when (action) {
        ACTION_SPRITE_BUTTON_UP -> commandPress(timeMillis, long = false)
        ACTION_SPRITE_BUTTON_LONG_PRESS -> commandPress(timeMillis, long = true)
        else -> emptyList()
    }

    fun cancel() {
        composite = null
    }

    private fun commandPress(upAt: Long, long: Boolean): List<BuiltInControlEvent> {
        val downAt = upAt - (if (long) longPressMillis + 1 else 1)
        return listOf(
            BuiltInControlEvent(SemanticControl.COMMAND, PhysicalAction.DOWN, downAt),
            BuiltInControlEvent(SemanticControl.COMMAND, PhysicalAction.UP, upAt),
        )
    }

    private fun keyPhase(
        keyCode: Int,
        action: PhysicalAction,
        timeMillis: Long,
    ): List<BuiltInControlEvent> {
        val current = composite
        if (current == null) {
            if (keyCode == KEY_DASHBOARD && action == PhysicalAction.DOWN) {
                composite = Composite(null, mutableSetOf(KEY_DASHBOARD), emitted = false)
            }
            return emptyList()
        }
        if (keyCode == KEY_DASHBOARD) return emptyList()
        val direction = directionFor(keyCode) ?: return emptyList()
        val control = current.control ?: direction
        if (control != direction) return emptyList()
        current.seen += keyCode
        return when (action) {
            PhysicalAction.DOWN -> if (current.emitted) emptyList() else {
                composite = Composite(control, current.seen, emitted = true)
                listOf(BuiltInControlEvent(control, PhysicalAction.DOWN, timeMillis))
            }
            PhysicalAction.UP -> if (current.seen.size >= DIRECTIONAL_KEYS) {
                composite = null
                listOf(BuiltInControlEvent(control, PhysicalAction.UP, timeMillis))
            } else emptyList()
            PhysicalAction.REPEAT -> emptyList()
            PhysicalAction.CANCEL -> emptyList()
        }
    }

    private fun directionFor(keyCode: Int): SemanticControl? = when (keyCode) {
        KEY_LEFT, KEY_UP -> SemanticControl.UP
        KEY_RIGHT, KEY_DOWN -> SemanticControl.DOWN
        else -> null
    }

    companion object {
        const val OWNER_CODE = 83
        const val KEY_DASHBOARD = 83
        const val KEY_LEFT = 21
        const val KEY_RIGHT = 22
        const val KEY_UP = 19
        const val KEY_DOWN = 20
        const val ACTION_SPRITE_BUTTON_UP = "com.android.action.ACTION_SPRITE_BUTTON_UP"
        const val ACTION_SPRITE_BUTTON_LONG_PRESS = "com.android.action.ACTION_SPRITE_BUTTON_LONG_PRESS"
        private const val DIRECTIONAL_KEYS = 3
    }
}
