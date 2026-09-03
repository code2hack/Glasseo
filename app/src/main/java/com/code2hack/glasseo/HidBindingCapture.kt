package com.code2hack.glasseo

enum class HidBindingCapturePhase {
    IDLE,
    AWAITING_DOWN,
    AWAITING_UP,
    COMMITTED,
    DUPLICATE,
    INVALID,
    CANCELLED,
    TIMED_OUT,
}

data class HidBindingCaptureSnapshot(
    val requestId: String?,
    val control: SemanticControl?,
    val phase: HidBindingCapturePhase,
    val profileRevision: Long,
    val candidateLabel: String? = null,
    val error: String? = null,
    val deadlineMillis: Long? = null,
)

class HidBindingCapture(
    private val store: HidBindingStore,
    private val timeoutMillis: Long = 15_000,
    private val timing: InputTiming = InputTiming(),
) {
    private data class ActivePress(
        val owner: PhysicalOwner,
        val identity: HidPhysicalIdentity,
        val downAtMillis: Long,
    )

    private var press: ActivePress? = null
    var snapshot = idle()
        private set

    val isActive: Boolean
        get() = snapshot.phase == HidBindingCapturePhase.AWAITING_DOWN ||
            snapshot.phase == HidBindingCapturePhase.AWAITING_UP

    fun start(control: SemanticControl, requestId: String, nowMillis: Long): HidBindingCaptureSnapshot {
        require(requestId.matches(Regex("[A-Za-z0-9_-]{1,64}"))) { "Invalid request ID" }
        press = null
        snapshot = HidBindingCaptureSnapshot(
            requestId,
            control,
            HidBindingCapturePhase.AWAITING_DOWN,
            store.profile.revision,
            deadlineMillis = nowMillis + timeoutMillis,
        )
        return snapshot
    }

    fun handle(input: HidRawInput): HidBindingCaptureSnapshot {
        if (!isActive) return snapshot
        if (runCatching(input.identity::requirePersistable).isFailure) return finish(
            HidBindingCapturePhase.INVALID,
            error = "invalid_hid_input",
        )
        return when (input.action) {
            PhysicalAction.DOWN -> {
                if (press != null) finish(HidBindingCapturePhase.INVALID, error = "multiple_down")
                else {
                    press = ActivePress(input.owner(), input.identity, input.eventTimeMillis)
                    snapshot = snapshot.copy(
                        phase = HidBindingCapturePhase.AWAITING_UP,
                        candidateLabel = input.identity.displayLabel(),
                    )
                    snapshot
                }
            }
            PhysicalAction.REPEAT -> if (press?.matches(input) == true) snapshot else {
                finish(HidBindingCapturePhase.INVALID, error = "mismatched_repeat")
            }
            PhysicalAction.UP -> {
                val active = press
                if (active == null || !active.matches(input)) {
                    finish(HidBindingCapturePhase.INVALID, error = "mismatched_up")
                } else if (input.eventTimeMillis - active.downAtMillis !in 0 until timing.longPressMillis) {
                    finish(HidBindingCapturePhase.INVALID, error = "binding_press_not_short")
                } else {
                    val mutation = store.bind(checkNotNull(snapshot.control), active.identity)
                    when (mutation.status) {
                        HidBindingStatus.BOUND, HidBindingStatus.UNCHANGED -> finish(
                            HidBindingCapturePhase.COMMITTED,
                            mutation.profile.revision,
                        )
                        HidBindingStatus.DUPLICATE -> finish(
                            HidBindingCapturePhase.DUPLICATE,
                            mutation.profile.revision,
                            error = "duplicate_binding",
                        )
                        HidBindingStatus.INVALID -> finish(
                            HidBindingCapturePhase.INVALID,
                            mutation.profile.revision,
                            error = "invalid_hid_input",
                        )
                        HidBindingStatus.STORAGE_ERROR -> finish(
                            HidBindingCapturePhase.INVALID,
                            mutation.profile.revision,
                            error = "storage_error",
                        )
                        HidBindingStatus.RESET -> error("Unexpected reset result")
                    }
                }
            }
            PhysicalAction.CANCEL -> if (press?.matches(input) == true) {
                finish(HidBindingCapturePhase.CANCELLED, error = "key_cancelled")
            } else {
                finish(HidBindingCapturePhase.INVALID, error = "mismatched_cancel")
            }
        }
    }

    fun cancel(requestId: String? = null, reason: String = "cancelled"): HidBindingCaptureSnapshot {
        if (!isActive || requestId != null && requestId != snapshot.requestId) return snapshot
        return finish(HidBindingCapturePhase.CANCELLED, error = reason)
    }

    fun advance(nowMillis: Long): HidBindingCaptureSnapshot {
        if (isActive && nowMillis >= checkNotNull(snapshot.deadlineMillis)) {
            finish(HidBindingCapturePhase.TIMED_OUT, error = "timeout")
        }
        return snapshot
    }

    fun cancelDevice(deviceId: Int): HidBindingCaptureSnapshot {
        if (snapshot.phase == HidBindingCapturePhase.AWAITING_DOWN || press?.owner?.deviceId == deviceId) {
            cancel(reason = "disconnect")
        }
        return snapshot
    }

    private fun finish(
        phase: HidBindingCapturePhase,
        revision: Long = store.profile.revision,
        error: String? = null,
    ): HidBindingCaptureSnapshot {
        press = null
        snapshot = snapshot.copy(
            phase = phase,
            profileRevision = revision,
            error = error,
            deadlineMillis = null,
        )
        return snapshot
    }

    private fun idle() = HidBindingCaptureSnapshot(
        requestId = null,
        control = null,
        phase = HidBindingCapturePhase.IDLE,
        profileRevision = store.profile.revision,
    )

    private fun HidRawInput.owner() = PhysicalOwner(PhysicalSource.HID, deviceId, identity.keyCode)

    private fun ActivePress.matches(input: HidRawInput) = owner == input.owner() && identity.sameControl(input.identity)

    private fun HidPhysicalIdentity.displayLabel() =
        "Key $keyCode/$scanCode · %04x:%04x".format(vendorId, productId)
}
