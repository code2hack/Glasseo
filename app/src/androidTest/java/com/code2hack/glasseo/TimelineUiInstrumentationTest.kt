package com.code2hack.glasseo

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TimelineUiInstrumentationTest {
    @Before fun resetProbe() = ProbeState.reset()

    @Test fun timelineRowsStayStableAndContainedAt480x640() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitWebReady()
            scenario.onActivity { activity -> activity.evaluateJavascriptForTest(SCRIPT) }
            val result = awaitResult(scenario)
            assertEquals(480, result.getInt("width"))
            assertEquals(640, result.getInt("height"))
            assertTrue(result.getDouble("headerBottom") <= result.getDouble("bodyTop"))
            assertTrue(result.getDouble("bodyBottom") <= result.getDouble("height"))
            assertTrue(result.getInt("documentScrollWidth") <= result.getInt("width"))
            assertTrue(result.getInt("viewportScrollWidth") <= result.getInt("viewportClientWidth"))
            assertTrue(result.getBoolean("stableRow"))
            val diagnostics = result.getJSONObject("diagnostics")
            assertEquals(3, diagnostics.getInt("rowCount"))
            assertEquals(0, diagnostics.getInt("duplicateDomRows"))
            assertEquals(8, diagnostics.getString("keyHash").length)
            assertEquals(2, result.getJSONObject("calls").getInt("following"))
            assertTrue(result.getJSONObject("calls").getInt("acknowledged") >= 1)
            assertTrue(!diagnostics.toString().contains("Unicode"))
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
                activity.evaluateJavascriptForTest("document.body.dataset.timelineUi || ''") {
                    result = JSONObject("{\"value\":$it}").getString("value")
                    latch.countDown()
                }
            }
            assertTrue("JavaScript timed out", latch.await(10, TimeUnit.SECONDS))
            if (result.startsWith("ok:")) return JSONObject(result.removePrefix("ok:"))
            if (result.startsWith("error:")) throw AssertionError(result)
            Thread.sleep(50)
        }
        throw AssertionError("Timeline UI acceptance did not report")
    }

    companion object {
        private val SCRIPT = """
            import('./timeline/ui-acceptance-entry.js')
              .then(() => document.body.dataset.timelineUi = 'ok:' + JSON.stringify(window.__glasseoTimelineUiAcceptance.run()))
              .catch(error => document.body.dataset.timelineUi = 'error:' + String(error))
        """.trimIndent()
    }
}
