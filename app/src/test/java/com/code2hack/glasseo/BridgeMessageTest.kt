package com.code2hack.glasseo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeMessageTest {
    @Test fun parsesKnownMessages() {
        assertEquals(BridgeMessage.Hello, BridgeMessage.parse("{\"type\":\"hello\"}"))
        val result = BridgeMessage.parse(
            "{\"type\":\"probe-result\",\"passed\":true,\"checks\":{\"origin\":true},\"details\":{\"origin\":\"PASS\"}}",
        )
        assertTrue((result as BridgeMessage.ProbeResult).passed)
    }

    @Test fun rejectsMalformedAndUnknownMessages() {
        listOf("{}", "{\"type\":\"other\"}", "{\"type\":\"hello\",\"extra\":true}").forEach {
            assertThrows(Exception::class.java) { BridgeMessage.parse(it) }
        }
    }
}
