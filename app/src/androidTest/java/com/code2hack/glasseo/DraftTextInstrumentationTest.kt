package com.code2hack.glasseo

import android.content.Intent
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.View
import android.view.ViewGroup
import androidx.test.core.app.ApplicationProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DraftTextInstrumentationTest {
    @Before fun resetProbe() = ProbeState.reset()

    @Test fun textEditingPersistenceAndLayoutPassOnThePhysicalDisplay() {
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
            assertTrue(result.getBoolean("cursorVisible"))
            assertTrue(result.getBoolean("moved"))
            assertTrue(result.getBoolean("selectionStarted"))
            assertEquals(2, result.getInt("selectionCount"))
            assertTrue(result.getBoolean("copied"))
            assertTrue(result.getBoolean("cut"))
            assertTrue(result.getBoolean("dw"))
            assertTrue(result.getBoolean("doubleUnconsumed"))
            assertTrue(result.getBoolean("doublePreserved"))
            assertTrue(result.getBoolean("leavingCleared"))
            assertTrue(result.getBoolean("stableToken"))
            assertTrue(result.getBoolean("noHtmlElement"))
            assertTrue(result.getInt("persistedRevision") > 0)
            assertTrue(result.getBoolean("restartMatches"))
            assertTrue(result.getBoolean("restartTransientReset"))
            assertTrue(result.getBoolean("diagnosticsRedacted"))
            val diagnostics = result.getJSONObject("diagnostics")
            assertEquals(0, diagnostics.getInt("duplicateDomAreas"))
            assertEquals(0, diagnostics.getInt("duplicateDomUnits"))
            assertFalse(diagnostics.getBoolean("textSelectionActive"))
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
                activity.evaluateJavascriptForTest("document.body.dataset.draftTextUi || ''") {
                    result = JSONObject("{\"value\":$it}").getString("value")
                    latch.countDown()
                }
            }
            assertTrue("JavaScript timed out", latch.await(10, TimeUnit.SECONDS))
            if (result.startsWith("ok:")) return JSONObject(result.removePrefix("ok:"))
            if (result.startsWith("error:")) throw AssertionError(result)
            Thread.sleep(50)
        }
        throw AssertionError("Draft Text acceptance did not report")
    }

    companion object {
        private val SCRIPT = """
            import('./draft/text/ui-acceptance-entry.js')
              .then(() => window.__glasseoDraftTextAcceptance.run())
              .then(result => document.body.dataset.draftTextUi = 'ok:' + JSON.stringify(result))
              .catch(error => document.body.dataset.draftTextUi = 'error:' + String(error))
        """.trimIndent()
    }
}

@RunWith(AndroidJUnit4::class)
class DraftTextPhysicalInstrumentationTest {
    @Before fun resetProbe() = ProbeState.reset()

    @Test fun domProgressWaitDoesNotCompleteAtTheFirstIntermediateValue() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitWebReady()
            scenario.onActivity {
                it.evaluateJavascriptForTest(
                    "document.body.dataset.pollRegression = '1';" +
                        "setTimeout(() => document.body.dataset.pollRegression = '8', 250)",
                )
            }
            assertEquals(
                "8",
                awaitDomValue(scenario, "document.body.dataset.pollRegression || ''", 5_000, "8"),
            )
        }
    }

    @Test fun boundedJoyConSequenceEditsTextAndHidesHud() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("physical") == "true")
        val launchIntent = Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
            .putExtra(MainActivity.INPUT_CAPTURE_EXTRA, true)
        ActivityScenario.launch<MainActivity>(launchIntent).use { scenario ->
            awaitWebReady()
            assertTrue(ProbeState.await(60)?.isPassing() == true)
            scenario.onActivity { activity ->
                val device = InputDevice.getDeviceIds().asSequence()
                    .mapNotNull(InputDevice::getDevice)
                    .first { it.vendorId == 0x057e && it.productId == 0x2007 }
                val bindings = (activity.application as GlasseoApplication).hidBindings
                bindings.clear()
                mapOf(
                    SemanticControl.PRIMARY to (103 to 311),
                    SemanticControl.SECONDARY to (105 to 313),
                    SemanticControl.COMMAND to (107 to 318),
                    SemanticControl.UP to (99 to 307),
                    SemanticControl.DOWN to (96 to 304),
                    SemanticControl.LEFT to (100 to 308),
                    SemanticControl.RIGHT to (97 to 305),
                ).forEach { (control, codes) ->
                    assertTrue(
                        bindings.bind(
                            control,
                            HidPhysicalIdentity(
                                device.descriptor,
                                device.vendorId,
                                device.productId,
                                codes.first,
                                codes.second,
                                device.sources,
                            ),
                        ),
                    )
                }
                assertEquals(7, bindings.size)
                Log.d(
                    "Glasseo",
                    "event=draft-text-physical-bindings detail=count=7 descriptor=${device.descriptor} " +
                        "vendor=${device.vendorId} product=${device.productId}",
                )
                activity.evaluateJavascriptForTest(BEGIN_SCRIPT)
            }
            assertEquals("ready", awaitDomValue(scenario, "document.body.dataset.draftTextPhysical || ''", 20_000))
            val preflight = JSONObject(awaitDomValue(scenario, PREFLIGHT_SCRIPT, 20_000))
            assertTrue(preflight.getBoolean("productVisible"))
            assertTrue(preflight.getBoolean("qualificationAbsent"))
            assertTrue(preflight.getBoolean("draftVisible"))
            assertTrue(preflight.getBoolean("textActive"))
            assertTrue(preflight.getBoolean("cursorVisible"))
            assertTrue(preflight.getBoolean("armed"))
            assertEquals(0, preflight.getInt("handledActions"))
            Log.d(
                "Glasseo",
                "event=draft-text-physical-armed detail=product=true qualification=false draft=true text=true " +
                    "cursor=true listener=true handled=0",
            )
            if (InstrumentationRegistry.getArguments().getString("replay") == "true") {
                scenario.onActivity(::replayPhysicalSequence)
                assertTrue(ProbeState.awaitSemanticReceipt(10) != null)
            }
            assertEquals(
                "8",
                awaitDomValue(
                    scenario,
                    "document.body.dataset.draftTextPhysicalHandled || ''",
                    300_000,
                    "8",
                ),
            )
            val hiddenDeadline = System.currentTimeMillis() + 30_000
            while (System.currentTimeMillis() < hiddenDeadline && !hudHidden(scenario)) Thread.sleep(50)
            assertTrue("Double SECONDARY did not hide the HUD", hudHidden(scenario))
            scenario.onActivity { it.evaluateJavascriptForTest(FINISH_SCRIPT) }
            val result = JSONObject(awaitDomValue(scenario, "document.body.dataset.draftTextPhysicalResult || ''", 20_000))
            assertTrue(result.getBoolean("sequenceMatches"))
            assertEquals(8, result.getInt("handledActions"))
            assertTrue(result.getBoolean("textMatches"))
            assertTrue(result.getBoolean("cursorMatches"))
            assertEquals(5, result.getInt("copyLength"))
            assertTrue(result.getBoolean("selectionCleared"))
            assertTrue(result.getInt("revision") > 0)
            assertTrue(result.getBoolean("restartMatches"))
            assertTrue(result.getBoolean("restartTransientReset"))
            assertTrue(result.getBoolean("diagnosticsRedacted"))
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

    private fun awaitDomValue(
        scenario: ActivityScenario<MainActivity>,
        expression: String,
        timeoutMillis: Long,
        expected: String? = null,
    ): String {
        val deadline = System.currentTimeMillis() + timeoutMillis
        while (System.currentTimeMillis() < deadline) {
            val latch = CountDownLatch(1)
            var value = ""
            scenario.onActivity { activity ->
                activity.evaluateJavascriptForTest(expression) {
                    value = JSONObject("{\"value\":$it}").getString("value")
                    latch.countDown()
                }
            }
            assertTrue("JavaScript timed out", latch.await(10, TimeUnit.SECONDS))
            if (value.startsWith("error:")) throw AssertionError(value)
            if (value.isNotEmpty() && (expected == null || value == expected)) return value
            Thread.sleep(50)
        }
        throw AssertionError("Draft Text physical acceptance timed out")
    }

    private fun hudHidden(scenario: ActivityScenario<MainActivity>): Boolean {
        var hidden = false
        scenario.onActivity {
            val content = it.findViewById<ViewGroup>(android.R.id.content)
            val activityRoot = content.getChildAt(0) as ViewGroup
            hidden = activityRoot.getChildAt(0).visibility != View.VISIBLE
        }
        return hidden
    }

    private fun replayPhysicalSequence(activity: MainActivity) {
        var time = SystemClock.elapsedRealtime()
        fun send(control: SemanticControl, code: Int, action: PhysicalAction, advance: Long) {
            activity.submitPhysicalInputForTest(
                PhysicalInput(PhysicalOwner(PhysicalSource.HID, 5, code), control, action, time),
            )
            time += advance
        }
        fun tap(control: SemanticControl, code: Int) {
            send(control, code, PhysicalAction.DOWN, 80)
            send(control, code, PhysicalAction.UP, 120)
        }
        fun hold(control: SemanticControl, code: Int) {
            send(control, code, PhysicalAction.DOWN, 700)
            send(control, code, PhysicalAction.UP, 120)
        }
        tap(SemanticControl.UP, 99)
        tap(SemanticControl.DOWN, 96)
        tap(SemanticControl.PRIMARY, 103)
        tap(SemanticControl.DOWN, 96)
        tap(SemanticControl.PRIMARY, 103)
        tap(SemanticControl.PRIMARY, 103)
        hold(SemanticControl.SECONDARY, 105)
        hold(SemanticControl.SECONDARY, 105)
        tap(SemanticControl.SECONDARY, 105)
        tap(SemanticControl.SECONDARY, 105)
    }

    companion object {
        private val PREFLIGHT_SCRIPT = """
            JSON.stringify({
              productVisible: !document.querySelector('#app').hidden,
              qualificationAbsent: document.querySelector('#diagnostics').hidden,
              draftVisible: document.querySelector('#agent-body').dataset.destination === 'draft',
              textActive: document.querySelector('[data-area="text"]').getAttribute('aria-current') === 'true',
              cursorVisible: !!document.querySelector('[data-area="text"] .draft-unit.cursor'),
              armed: document.body.dataset.draftTextPhysical === 'ready',
              handledActions: Number(document.body.dataset.draftTextPhysicalHandled),
            })
        """.trimIndent()
        private val BEGIN_SCRIPT = """
            import('./draft/text/ui-acceptance-entry.js')
              .then(() => window.__glasseoDraftTextAcceptance.beginPhysical())
              .catch(error => document.body.dataset.draftTextPhysical = 'error:' + String(error))
        """.trimIndent()
        private val FINISH_SCRIPT = """
            window.__glasseoDraftTextAcceptance.finishPhysical()
              .then(result => document.body.dataset.draftTextPhysicalResult = JSON.stringify(result))
              .catch(error => document.body.dataset.draftTextPhysicalResult = 'error:' + String(error))
        """.trimIndent()
    }
}
