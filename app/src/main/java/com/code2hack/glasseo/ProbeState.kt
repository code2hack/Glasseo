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
    private var latch = CountDownLatch(1)

    @Synchronized fun reset() {
        helloCount = 0
        result = null
        blockedNavigations = 0
        rendererGone = 0
        latch = CountDownLatch(1)
    }

    @Synchronized fun record(message: BridgeMessage) {
        when (message) {
            BridgeMessage.Hello -> helloCount++
            is BridgeMessage.ProbeResult -> {
                result = message
                latch.countDown()
            }
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
}
