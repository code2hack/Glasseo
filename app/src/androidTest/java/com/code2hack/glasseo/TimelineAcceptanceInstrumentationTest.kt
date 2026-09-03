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
class TimelineAcceptanceInstrumentationTest {
    @Before fun waitForPriorPermissionMutation() {
        ProbeState.reset()
        Thread.sleep(500)
    }

    @Test fun deterministicTimelineRunsInTheProductionWebViewAndIndexedDb() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitWebReady()
            scenario.onActivity {
                it.evaluateJavascriptForTest(
                    """
                    import('./timeline/acceptance-entry.js')
                      .then(() => window.__glasseoTimelineAcceptance.runDeterministic())
                      .then(value => document.querySelector('#pairing-state').textContent = 'timeline:' + JSON.stringify(value))
                      .catch(error => document.querySelector('#pairing-state').textContent = 'timeline-error:' + String(error))
                    """.trimIndent(),
                )
            }
            val value = awaitResult(scenario)
            assertEquals(1, value.getInt("rowCount"))
            assertEquals(7, value.getJSONObject("range").getInt("startSeq"))
            assertEquals(7, value.getJSONObject("range").getInt("endSeq"))
            assertEquals(1, value.getInt("duplicateCount"))
            assertEquals(2, value.getInt("gapCount"))
            assertEquals(false, value.getBoolean("stale"))
            assertTrue(value.isNull("error"))
            assertEquals(8, value.getString("keyHash").length)
            assertEquals(value.getString("keyHash"), value.getString("subscriptionTargetHash"))
            assertTrue(!value.toString().contains("redacted"))
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

    private fun awaitResult(scenario: ActivityScenario<MainActivity>): JSONObject {
        val deadline = System.currentTimeMillis() + 20_000
        var value = ""
        while (System.currentTimeMillis() < deadline) {
            val latch = CountDownLatch(1)
            scenario.onActivity { activity ->
                activity.readPairingStateForTest {
                    value = JSONObject("{\"value\":$it}").getString("value")
                    latch.countDown()
                }
            }
            assertTrue(latch.await(10, TimeUnit.SECONDS))
            if (value.startsWith("timeline:"))
                return JSONObject(value.removePrefix("timeline:"))
            if (value.startsWith("timeline-error:")) throw AssertionError(value)
            Thread.sleep(50)
        }
        throw AssertionError("Timeline acceptance did not report: $value")
    }
}
