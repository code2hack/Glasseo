package com.code2hack.glasseo

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

object ProbeState {
    @Volatile var helloCount = 0
        private set
    @Volatile var result: BridgeMessage.ProbeResult? = null
        private set
    @Volatile var blockedNavigations = 0
        private set
    @Volatile var rendererGone = 0
        private set
    @Volatile var semanticReceipt: BridgeMessage.SemanticReceived? = null
        private set
    private val qualificationRenderHistory = mutableListOf<BridgeMessage.QualificationRendered>()
    val qualificationRenders: List<BridgeMessage.QualificationRendered>
        @Synchronized get() = qualificationRenderHistory.toList()
    private val hidQualificationRenderHistory = mutableListOf<BridgeMessage.HidQualificationRendered>()
    val hidQualificationRenders: List<BridgeMessage.HidQualificationRendered>
        @Synchronized get() = hidQualificationRenderHistory.toList()
    private var latch = CountDownLatch(1)
    private var semanticLatch = CountDownLatch(1)

    @Synchronized fun reset() {
        helloCount = 0
        result = null
        blockedNavigations = 0
        rendererGone = 0
        semanticReceipt = null
        qualificationRenderHistory.clear()
        hidQualificationRenderHistory.clear()
        latch = CountDownLatch(1)
        semanticLatch = CountDownLatch(1)
    }

    @Synchronized fun record(message: BridgeMessage) {
        when (message) {
            BridgeMessage.Hello -> helloCount++
            is BridgeMessage.ProbeResult -> {
                result = message
                latch.countDown()
            }
            is BridgeMessage.SemanticReceived -> {
                semanticReceipt = message
                semanticLatch.countDown()
            }
            is BridgeMessage.QualificationStart -> Unit
            is BridgeMessage.QualificationRendered -> qualificationRenderHistory += message
            is BridgeMessage.HidQualificationRendered -> hidQualificationRenderHistory += message
        }
    }

    @Synchronized fun recordBlockedNavigation() {
        blockedNavigations++
    }

    @Synchronized fun recordRendererGone() {
        rendererGone++
    }

    fun await(timeoutSeconds: Long): BridgeMessage.ProbeResult? {
        latch.await(timeoutSeconds, TimeUnit.SECONDS)
        return result
    }

    fun awaitSemanticReceipt(timeoutSeconds: Long): BridgeMessage.SemanticReceived? {
        semanticLatch.await(timeoutSeconds, TimeUnit.SECONDS)
        return semanticReceipt
    }
}
