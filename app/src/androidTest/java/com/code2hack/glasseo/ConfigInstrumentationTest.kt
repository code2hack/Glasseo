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
class ConfigInstrumentationTest {
    @Before fun resetProbe() = ProbeState.reset()

    @Test fun configHierarchyStaysStableAndContainedAt480x640() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitWebReady()
            assertTrue(ProbeState.await(60)?.isPassing() == true)
            scenario.onActivity {
                it.emitForTest(SemanticInteraction(SemanticControl.COMMAND, SemanticAction.LONG, 900, 900))
                val owner = PhysicalOwner(PhysicalSource.BUILT_IN, -10, 20)
                it.submitPhysicalInputForTest(PhysicalInput(owner, SemanticControl.DOWN, PhysicalAction.DOWN, 901))
                it.submitPhysicalInputForTest(PhysicalInput(owner, SemanticControl.DOWN, PhysicalAction.REPEAT, 902))
                it.submitPhysicalInputForTest(PhysicalInput(owner, SemanticControl.DOWN, PhysicalAction.UP, 903))
            }
            val product = awaitProductConfig(scenario)
            assertEquals(1, product.getInt("interactionId"))
            assertEquals("BEGIN", product.getString("action"))
            assertEquals("config", product.getString("destination"))
            assertEquals(480, product.getInt("width"))
            assertEquals(640, product.getInt("height"))
            assertTrue(product.getInt("headerBottom") <= product.getInt("bodyTop"))
            assertTrue(product.getInt("bodyBottom") <= product.getInt("height"))
            assertTrue(product.getInt("documentScrollWidth") <= product.getInt("width"))
            assertTrue(product.getInt("viewportScrollWidth") <= product.getInt("viewportClientWidth"))
            scenario.onActivity { activity -> activity.evaluateJavascriptForTest(SCRIPT) }
            val result = awaitResult(scenario)
            assertEquals(480, result.getInt("width"))
            assertEquals(640, result.getInt("height"))
            assertTrue(result.getDouble("headerBottom") <= result.getDouble("bodyTop"))
            assertTrue(result.getDouble("bodyBottom") <= result.getDouble("height"))
            assertTrue(result.getInt("documentScrollWidth") <= result.getInt("width"))
            assertTrue(result.getInt("viewportScrollWidth") <= result.getInt("viewportClientWidth"))
            assertTrue(result.getBoolean("stableRow"))
            assertEquals(1, result.getInt("selectedCount"))
            assertEquals("acceptance-alpha", result.getString("selectedServer"))
            assertEquals("shared-agent", result.getString("selectedAgent"))
            val diagnostics = result.getJSONObject("diagnostics")
            assertEquals(2, diagnostics.getInt("hosts"))
            assertEquals(2, diagnostics.getInt("agents"))
            assertEquals(0, diagnostics.getInt("duplicateDomRows"))
            assertEquals(8, diagnostics.getString("selectedAgentKeyHash").length)
            assertTrue(!diagnostics.toString().contains("acceptance-alpha"))
            assertTrue(!diagnostics.toString().contains("shared-agent"))
            assertEquals(0, ProbeState.rendererGone)
        }
    }

    private fun awaitProductConfig(scenario: ActivityScenario<MainActivity>): JSONObject {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            val latch = CountDownLatch(1)
            var value = ""
            scenario.onActivity { activity ->
                activity.evaluateJavascriptForTest(PRODUCT_SCRIPT) {
                    value = JSONObject("{\"value\":$it}").getString("value")
                    latch.countDown()
                }
            }
            assertTrue("JavaScript timed out", latch.await(10, TimeUnit.SECONDS))
            if (value.isNotEmpty()) return JSONObject(value)
            Thread.sleep(50)
        }
        throw AssertionError("Product Config did not report")
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
                activity.evaluateJavascriptForTest("document.body.dataset.configUi || ''") {
                    result = JSONObject("{\"value\":$it}").getString("value")
                    latch.countDown()
                }
            }
            assertTrue("JavaScript timed out", latch.await(10, TimeUnit.SECONDS))
            if (result.startsWith("ok:")) return JSONObject(result.removePrefix("ok:"))
            if (result.startsWith("error:")) throw AssertionError(result)
            Thread.sleep(50)
        }
        throw AssertionError("Config UI acceptance did not report")
    }

    companion object {
        private val PRODUCT_SCRIPT = """
            (() => {
              const diagnostics = window.glasseoDiagnostics
              const body = document.querySelector('#agent-body')?.getBoundingClientRect()
              const header = document.querySelector('#agent-header')?.getBoundingClientRect()
              const viewport = document.querySelector('.config-viewport')
              if (diagnostics?.config?.lastInteractionId !== 1 || !body || !header || !viewport) return ''
              return JSON.stringify({
                interactionId: diagnostics.config.lastInteractionId,
                action: diagnostics.config.lastAction,
                destination: diagnostics.destination,
                width: innerWidth,
                height: innerHeight,
                headerBottom: Math.round(header.bottom),
                bodyTop: Math.round(body.top),
                bodyBottom: Math.round(body.bottom),
                documentScrollWidth: document.documentElement.scrollWidth,
                viewportScrollWidth: viewport.scrollWidth,
                viewportClientWidth: viewport.clientWidth,
              })
            })()
        """.trimIndent()
        private val SCRIPT = """
            import('./config/ui-acceptance-entry.js')
              .then(() => Promise.resolve(window.__glasseoConfigUiAcceptance.run()))
              .then(result => document.body.dataset.configUi = 'ok:' + JSON.stringify(result))
              .catch(error => document.body.dataset.configUi = 'error:' + String(error))
        """.trimIndent()
    }
}
