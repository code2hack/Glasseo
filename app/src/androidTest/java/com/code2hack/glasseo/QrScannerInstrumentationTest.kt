package com.code2hack.glasseo

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class QrScannerInstrumentationTest {
    @Before fun grantCameraAndReset() {
        shell("pm grant com.code2hack.glasseo android.permission.CAMERA")
        ProbeState.reset()
    }

    @Test fun trustedBridgeStartsAndCancelsCameraWithoutLosingRenderer() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitWebReady()
            scenario.onActivity {
                it.evaluateJavascriptForTest(
                    "window.glasseoNative.postMessage(JSON.stringify({type:'scanner-start'}))",
                )
            }
            awaitScanner(scenario, true)
            scenario.onActivity {
                it.evaluateJavascriptForTest(
                    "window.glasseoNative.postMessage(JSON.stringify({type:'scanner-cancel'}))",
                )
            }
            awaitScanner(scenario, false)
            assertEquals(0, ProbeState.rendererGone)
        }
    }

    @Test fun nativeResultReachesWebOnceWithoutRendererLoss() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitWebReady()
            scenario.onActivity { it.evaluateJavascriptForTest("document.querySelector('#hosts button').click()") }
            awaitScanner(scenario, true)
            scenario.onActivity { it.postScannerEventForTest(QrScannerEvent.Result("not-an-offer")) }
            val deadline = System.currentTimeMillis() + 10_000
            var state = ""
            while (System.currentTimeMillis() < deadline) {
                state = readPairingState(scenario)
                if (state == "Pairing error: invalid_qr") break
                Thread.sleep(50)
            }
            assertEquals("Pairing error: invalid_qr", state)
            assertEquals(0, ProbeState.rendererGone)
        }
    }

    @Test fun recreationClosesAnActiveCameraSession() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitWebReady()
            scenario.onActivity {
                it.evaluateJavascriptForTest(
                    "window.glasseoNative.postMessage(JSON.stringify({type:'scanner-start'}))",
                )
            }
            awaitScanner(scenario, true)
            scenario.recreate()
            awaitScanner(scenario, false)
            assertEquals(0, ProbeState.rendererGone)
        }
    }

    private fun awaitWebReady() {
        val deadline = System.currentTimeMillis() + 20_000
        while (System.currentTimeMillis() < deadline) {
            if (ProbeState.helloCount > 0) return
            Thread.sleep(50)
        }
        throw AssertionError("Web bridge did not become ready")
    }

    private fun awaitScanner(scenario: ActivityScenario<MainActivity>, active: Boolean) {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            var actual = !active
            scenario.onActivity { actual = it.scannerActiveForTest() }
            if (actual == active) return
            Thread.sleep(50)
        }
        if (active) assertTrue("Scanner did not start", false) else assertFalse("Scanner did not stop", true)
    }

    private fun readPairingState(scenario: ActivityScenario<MainActivity>): String {
        val latch = CountDownLatch(1)
        var value = ""
        scenario.onActivity { activity ->
            activity.readPairingStateForTest {
                value = JSONObject("{\"value\":$it}").getString("value")
                latch.countDown()
            }
        }
        assertTrue(latch.await(10, TimeUnit.SECONDS))
        return value
    }

    private fun shell(command: String) {
        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command).close()
    }

}
