package com.code2hack.glasseo

interface QrScannerSession : AutoCloseable

enum class QrScannerState(val wireValue: String) {
    REQUESTING_PERMISSION("requesting-permission"),
    SCANNING("scanning"),
}

enum class QrScannerErrorCode(val wireValue: String) {
    CAMERA_DENIED("camera_denied"),
    CAMERA_UNAVAILABLE("camera_unavailable"),
    DECODE_ERROR("decode_error"),
    BUSY("busy"),
}

sealed interface QrScannerEvent {
    data class State(val state: QrScannerState) : QrScannerEvent
    data class Result(val value: String) : QrScannerEvent
    data class Error(val code: QrScannerErrorCode) : QrScannerEvent
    data object Cancelled : QrScannerEvent
}

class QrScannerController(
    private val hasPermission: () -> Boolean,
    private val requestPermission: () -> Unit,
    private val openSession: ((String) -> Unit, (QrScannerErrorCode) -> Unit) -> QrScannerSession,
    private val emit: (QrScannerEvent) -> Unit,
) {
    private var permissionPending = false
    private var session: QrScannerSession? = null
    val isActive: Boolean get() = permissionPending || session != null

    fun start() {
        if (permissionPending || session != null) {
            emit(QrScannerEvent.Error(QrScannerErrorCode.BUSY))
        } else if (!hasPermission()) {
            permissionPending = true
            emit(QrScannerEvent.State(QrScannerState.REQUESTING_PERMISSION))
            requestPermission()
        } else {
            open()
        }
    }

    fun onPermissionResult(granted: Boolean) {
        if (!permissionPending) return
        permissionPending = false
        if (granted) open() else emit(QrScannerEvent.Error(QrScannerErrorCode.CAMERA_DENIED))
    }

    fun cancel() {
        val wasActive = permissionPending || session != null
        permissionPending = false
        session?.close()
        session = null
        if (wasActive) emit(QrScannerEvent.Cancelled)
    }

    fun onActivityPause() {
        if (session == null) return
        session?.close()
        session = null
        emit(QrScannerEvent.Cancelled)
    }

    private fun open() {
        try {
            session = openSession(::succeed, ::fail)
            emit(QrScannerEvent.State(QrScannerState.SCANNING))
        } catch (_: Exception) {
            session = null
            emit(QrScannerEvent.Error(QrScannerErrorCode.CAMERA_UNAVAILABLE))
        }
    }

    private fun succeed(value: String) {
        if (session == null || value.isEmpty()) return
        session?.close()
        session = null
        emit(QrScannerEvent.Result(value))
    }

    private fun fail(code: QrScannerErrorCode) {
        if (session == null) return
        session?.close()
        session = null
        emit(QrScannerEvent.Error(code))
    }
}
