package com.code2hack.glasseo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeMessageTest {
    @Test fun parsesKnownMessages() {
        assertEquals(BridgeMessage.Hello, BridgeMessage.parse("{\"type\":\"hello\"}"))
        assertEquals(BridgeMessage.ScannerStart, BridgeMessage.parse("{\"type\":\"scanner-start\"}"))
        assertEquals(BridgeMessage.ScannerCancel, BridgeMessage.parse("{\"type\":\"scanner-cancel\"}"))
        assertEquals(
            BridgeMessage.HostMediaCleanup(9, "host-a"),
            BridgeMessage.parse("{\"type\":\"host-media-cleanup\",\"requestId\":9,\"serverId\":\"host-a\"}"),
        )
        assertTrue((BridgeMessage.parse(passingProbe()) as BridgeMessage.ProbeResult).isPassing())
        assertEquals(
            BridgeMessage.SemanticReceived(SemanticControl.PRIMARY, SemanticAction.SHORT, 7),
            BridgeMessage.parse("{\"type\":\"semantic-received\",\"control\":\"PRIMARY\",\"action\":\"SHORT\",\"interactionId\":7}"),
        )
        assertEquals(
            BridgeMessage.QualificationStart(QualificationMode.HID),
            BridgeMessage.parse("{\"type\":\"qualification-start\",\"mode\":\"HID\"}"),
        )
        assertEquals(
            BridgeMessage.QualificationRendered("session-1", 7, 5, QualificationPhase.AWAITING_FIRST),
            BridgeMessage.parse(
                "{\"type\":\"qualification-rendered\",\"sessionId\":\"session-1\",\"revision\":7," +
                    "\"stepIndex\":5,\"phase\":\"AWAITING_FIRST\"}",
            ),
        )
        assertEquals(
            BridgeMessage.HidQualificationRendered(
                "hid-1",
                8,
                HidQualificationStage.BINDING,
                3,
                HidQualificationPhase.AWAITING_INPUT,
            ),
            BridgeMessage.parse(
                "{\"type\":\"hid-qualification-rendered\",\"sessionId\":\"hid-1\",\"revision\":8," +
                    "\"stage\":\"BINDING\",\"stepIndex\":3,\"phase\":\"AWAITING_INPUT\"}",
            ),
        )
    }

    @Test fun rejectsMalformedAndUnknownMessages() {
        listOf(
            "{}",
            "{\"type\":\"other\"}",
            "{\"type\":\"hello\",\"extra\":true}",
            "{\"type\":\"scanner-start\",\"extra\":true}",
            "{\"type\":\"host-media-cleanup\",\"requestId\":0,\"serverId\":\"host-a\"}",
            "{\"type\":\"semantic-received\",\"control\":\"OTHER\",\"action\":\"SHORT\",\"interactionId\":7}",
            "{\"type\":\"semantic-received\",\"control\":\"PRIMARY\",\"action\":\"SHORT\",\"interactionId\":0}",
            "{\"type\":\"qualification-start\",\"mode\":\"OTHER\"}",
            "{\"type\":\"qualification-rendered\",\"sessionId\":\"\",\"revision\":7," +
                "\"stepIndex\":5,\"phase\":\"AWAITING_FIRST\"}",
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
