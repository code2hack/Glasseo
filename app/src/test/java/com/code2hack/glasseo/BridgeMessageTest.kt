package com.code2hack.glasseo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeMessageTest {
    @Test fun parsesKnownMessages() {
        assertEquals(BridgeMessage.Hello, BridgeMessage.parse("{\"type\":\"hello\"}"))
        assertTrue((BridgeMessage.parse(passingProbe()) as BridgeMessage.ProbeResult).isPassing())
    }

    @Test fun rejectsMalformedAndUnknownMessages() {
        listOf(
            "{}",
            "{\"type\":\"other\"}",
            "{\"type\":\"hello\",\"extra\":true}",
            passingProbe().replace("\"passed\":true", "\"passed\":\"true\""),
            passingProbe().replace("\"secureRandom\":true", "\"secureRandom\":\"true\""),
        ).forEach {
            assertThrows(Exception::class.java) { BridgeMessage.parse(it) }
        }
    }

    @Test fun probeContractRejectsMissingUnknownAndContradictoryChecks() {
        val missing = passingProbe().replace(",\"remoteNavigationRejected\":true", "")
        val unknown = passingProbe().replace("\"localHttpsOrigin\":true", "\"localHttpsOrigin\":true,\"unknown\":true")
        val contradictory = passingProbe().replace("\"passed\":true", "\"passed\":false")

        listOf(missing, unknown, contradictory).forEach {
            assertThrows(Exception::class.java) { BridgeMessage.parse(it) }
        }
    }

    @Test fun requiredFalseCheckIsAValidFailureButNeverPassesAcceptance() {
        val failed = passingProbe()
            .replace("\"passed\":true", "\"passed\":false")
            .replace("\"secureRandom\":true", "\"secureRandom\":false")
        val result = BridgeMessage.parse(failed) as BridgeMessage.ProbeResult
        assertFalse(result.isPassing())
    }

    private fun passingProbe(): String {
        val checks = BridgeMessage.REQUIRED_CHECKS.joinToString(",") { "\"$it\":true" }
        val details = BridgeMessage.REQUIRED_CHECKS.joinToString(",") { "\"$it\":\"PASS\"" }
        return "{\"type\":\"probe-result\",\"passed\":true,\"checks\":{$checks},\"details\":{$details}}"
    }
}
