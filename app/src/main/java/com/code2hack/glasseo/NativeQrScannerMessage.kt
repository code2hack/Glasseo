package com.code2hack.glasseo

import org.json.JSONObject

object NativeQrScannerMessage {
    fun encode(event: QrScannerEvent): String = when (event) {
        is QrScannerEvent.State -> JSONObject()
            .put("type", "scanner-state")
            .put("state", event.state.wireValue)
        is QrScannerEvent.Result -> JSONObject()
            .put("type", "scanner-result")
            .put("value", event.value)
        is QrScannerEvent.Error -> JSONObject()
            .put("type", "scanner-error")
            .put("code", event.code.wireValue)
        QrScannerEvent.Cancelled -> JSONObject().put("type", "scanner-cancelled")
    }.toString()
}
