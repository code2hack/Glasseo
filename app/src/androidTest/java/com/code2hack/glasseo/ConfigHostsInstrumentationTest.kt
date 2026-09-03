package com.code2hack.glasseo

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
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
class ConfigHostsInstrumentationTest {
    @Before fun resetProbe() = ProbeState.reset()

    @Test fun hostsConfirmationCleanupAndRowsStayContainedAt480x640() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitWebReady()
            assertTrue(ProbeState.await(60)?.isPassing() == true)
            scenario.onActivity { activity -> activity.evaluateJavascriptForTest(SCRIPT) }
            val result = awaitResult(scenario)
            assertEquals(480, result.getInt("width"))
            assertEquals(640, result.getInt("height"))
            assertTrue(result.getDouble("headerBottom") <= result.getDouble("bodyTop"))
            assertTrue(result.getDouble("bodyBottom") <= result.getDouble("height"))
            assertTrue(result.getInt("documentScrollWidth") <= result.getInt("width"))
            assertTrue(result.getInt("viewportScrollWidth") <= result.getInt("viewportClientWidth"))
            assertEquals("Cancel removal", result.getString("confirmationDefault"))
            assertFalse(result.getBoolean("alphaPresent"))
            assertTrue(result.getBoolean("betaUsable"))
            assertEquals("acceptance-alpha", result.getJSONArray("cleaned").getString(0))
            val diagnostics = result.getJSONObject("diagnostics")
            assertEquals(0, diagnostics.getInt("duplicateDomRows"))
            assertEquals(1, diagnostics.getInt("hostCleanupCompleted"))
            assertEquals(0, diagnostics.getInt("hostCleanupFailed"))
            assertEquals(0, ProbeState.rendererGone)
        }
    }

    private fun awaitWebReady() {
        val deadline = System.currentTimeMillis() + 20_000
        while (System.currentTimeMillis() < deadline) {
            if (ProbeState.helloCount > 0) return
            Thread.sleep(50)
        }
        throw AssertionError("WebView did not become ready")
    }

    private fun awaitResult(scenario: ActivityScenario<MainActivity>): JSONObject {
        val deadline = System.currentTimeMillis() + 20_000
        while (System.currentTimeMillis() < deadline) {
            val latch = CountDownLatch(1)
            var result = ""
            scenario.onActivity { activity ->
                activity.evaluateJavascriptForTest("document.body.dataset.configHostsUi || ''") {
                    result = JSONObject("{\"value\":$it}").getString("value")
                    latch.countDown()
                }
            }
            assertTrue("JavaScript timed out", latch.await(10, TimeUnit.SECONDS))
            if (result.startsWith("ok:")) return JSONObject(result.removePrefix("ok:"))
            if (result.startsWith("error:")) throw AssertionError(result)
            Thread.sleep(50)
        }
        throw AssertionError("Config Hosts UI acceptance did not report")
    }

    companion object {
        private val SCRIPT = """
            import('./config/hosts/ui-acceptance-entry.js')
              .then(() => window.__glasseoConfigHostsAcceptance.run())
              .then(result => document.body.dataset.configHostsUi = 'ok:' + JSON.stringify(result))
              .catch(error => document.body.dataset.configHostsUi = 'error:' + String(error))
        """.trimIndent()
    }
}
