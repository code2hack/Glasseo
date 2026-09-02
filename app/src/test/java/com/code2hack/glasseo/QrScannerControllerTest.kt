package com.code2hack.glasseo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class QrScannerControllerTest {
    @Test fun permissionDenialAndSingleSessionAreDeterministic() {
        var granted = false
        var permissionRequests = 0
        var opens = 0
        val events = mutableListOf<QrScannerEvent>()
        val sessions = mutableListOf<FakeSession>()
        val controller = QrScannerController(
            hasPermission = { granted },
            requestPermission = { permissionRequests++ },
            openSession = { _, _ -> FakeSession().also { sessions += it; opens++ } },
            emit = events::add,
        )

        controller.start()
        controller.onActivityPause()
        assertTrue(controller.isActive)
        controller.start()
        controller.onPermissionResult(false)
        assertEquals(1, permissionRequests)
        assertEquals(
            listOf(
                QrScannerEvent.State(QrScannerState.REQUESTING_PERMISSION),
                QrScannerEvent.Error(QrScannerErrorCode.BUSY),
                QrScannerEvent.Error(QrScannerErrorCode.CAMERA_DENIED),
            ),
            events,
        )

        granted = true
        controller.start()
        controller.start()
        controller.cancel()
        assertEquals(1, opens)
        assertTrue(sessions.single().closed)
        assertEquals(QrScannerEvent.Cancelled, events.last())
    }

    @Test fun successAndCameraErrorCloseOnceAndNeverExposeResultInDiagnostics() {
        val events = mutableListOf<QrScannerEvent>()
        var result: (String) -> Unit = {}
        var error: (QrScannerErrorCode) -> Unit = {}
        val sessions = mutableListOf<FakeSession>()
        val controller = QrScannerController(
            hasPermission = { true },
            requestPermission = {},
            openSession = { onResult, onError ->
                result = onResult
                error = onError
                FakeSession().also(sessions::add)
            },
            emit = events::add,
        )

        controller.start()
        result("opaque-pairing-value")
        result("duplicate")
        assertTrue(sessions.single().closed)
        assertEquals(1, events.filterIsInstance<QrScannerEvent.Result>().size)
        assertEquals("opaque-pairing-value", (events.last() as QrScannerEvent.Result).value)

        controller.start()
        error(QrScannerErrorCode.CAMERA_UNAVAILABLE)
        assertTrue(sessions.last().closed)
        assertEquals(QrScannerEvent.Error(QrScannerErrorCode.CAMERA_UNAVAILABLE), events.last())
    }

    private class FakeSession : QrScannerSession {
        var closed = false
        override fun close() { closed = true }
    }

}
