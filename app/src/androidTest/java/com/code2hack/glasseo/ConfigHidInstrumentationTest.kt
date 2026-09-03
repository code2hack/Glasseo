package com.code2hack.glasseo

import android.content.Context
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ConfigHidInstrumentationTest {
    @Before fun resetProbe() = ProbeState.reset()

    @Test fun hidUiAcceptanceStaysContainedAndReportsDuplicateAt480x640() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitWebReady(scenario)
            assertTrue(ProbeState.await(60)?.isPassing() == true)
            scenario.onActivity { it.evaluateJavascriptForTest(SCRIPT) }
            val result = awaitResult(scenario)
            assertEquals(480, result.getInt("width"))
            assertEquals(640, result.getInt("height"))
            assertTrue(result.getDouble("headerBottom") <= result.getDouble("bodyTop"))
            assertTrue(result.getDouble("bodyBottom") <= result.getDouble("height"))
            assertTrue(result.getInt("documentScrollWidth") <= result.getInt("width"))
            assertTrue(result.getInt("viewportScrollWidth") <= result.getInt("viewportClientWidth"))
            assertTrue(result.getBoolean("captureStarted"))
            assertEquals("duplicate_binding", result.getString("duplicateDetail"))
            val labels = result.getJSONArray("sevenLabels")
            for (control in listOf(
                "PRIMARY",
                "SECONDARY",
                "COMMAND",
                "LEFT",
                "RIGHT",
                "UP",
                "DOWN",
            )) assertTrue("missing HID row $control", jsonContains(labels, control))
            assertEquals("Cancel reset", result.getString("confirmDefault"))
            assertTrue(result.getBoolean("resetConfirmed"))
            assertTrue(result.getBoolean("resetRestored"))
            assertEquals(0, result.getInt("duplicateRows"))
            assertEquals(0, ProbeState.rendererGone)
        }
    }

    @Test fun productionHidBindingSemanticLifecycleAndRestartOnExactRg() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitWebReady(scenario)
            assertTrue(ProbeState.await(60)?.isPassing() == true)
            scenario.onActivity { it.resetHidBindingsForTest("reset_0") }
            assertTrue(hidProfile(scenario).bindings.isEmpty())

            val identities = SemanticControl.entries.associateWith { identity(it, 0) }
            openConfig(scenario)
            awaitFocused(scenario, "Workspaces")
            navUntil(scenario, "Hosts", 1_001)
            navUntil(scenario, "HID Keys", 1_002)
            ProbeState.reset()
            activate(scenario, 1_005)
            val activateReceipt = ProbeState.awaitSemanticReceipt(5)
            assertTrue(
                "No semantic receipt after activate: $activateReceipt",
                activateReceipt != null,
            )
            awaitFocused(scenario, "HID Keys")
            val afterActivate = evaluate(
                scenario,
                "JSON.stringify(window.glasseoDiagnostics?.config ?? null)",
            )
            if (!afterActivate.contains("\"lastAction\":\"SHORT\""))
                throw AssertionError("activate did not reach Config: receipt=$activateReceipt $afterActivate")
            navUntil(scenario, "PRIMARY", 1_006)

            var time = 2_000L
            for (control in SemanticControl.entries) {
                if (control != SemanticControl.PRIMARY) {
                    navUntil(scenario, control.name, time++)
                }
                activate(scenario, time++)
                awaitCapturePhase(scenario, HidBindingCapturePhase.AWAITING_DOWN)
                val identity = identities.getValue(control)
                val deviceId = 700 + control.ordinal
                inject(scenario, PhysicalAction.DOWN, identity, deviceId, time++)
                inject(scenario, PhysicalAction.UP, identity, deviceId, time++)
                awaitCapturePhase(scenario, HidBindingCapturePhase.COMMITTED)
            }
            var profile = hidProfile(scenario)
            assertEquals(7, profile.bindings.size)
            identities.forEach { (control, identity) ->
                assertEquals(control, profile.controlFor(identity))
            }

            // Duplicate identity must not displace the bound control.
            scenario.onActivity {
                it.startHidBindingCaptureForTest(SemanticControl.SECONDARY, "duplicate")
            }
            awaitCapturePhase(scenario, HidBindingCapturePhase.AWAITING_DOWN)
            inject(scenario, PhysicalAction.DOWN, identities.getValue(SemanticControl.PRIMARY), 705, time++)
            inject(scenario, PhysicalAction.UP, identities.getValue(SemanticControl.PRIMARY), 705, time++)
            awaitCapturePhase(scenario, HidBindingCapturePhase.DUPLICATE)
            assertEquals("duplicate_binding", captureSnapshot(scenario).error)
            profile = hidProfile(scenario)
            assertEquals(7, profile.bindings.size)
            assertEquals(SemanticControl.PRIMARY, profile.controlFor(identities.getValue(SemanticControl.PRIMARY)))

            // Retry SECONDARY with its own identity after the duplicate.
            scenario.onActivity {
                it.startHidBindingCaptureForTest(SemanticControl.SECONDARY, "retry")
            }
            awaitCapturePhase(scenario, HidBindingCapturePhase.AWAITING_DOWN)
            inject(scenario, PhysicalAction.DOWN, identities.getValue(SemanticControl.SECONDARY), 701, time++)
            inject(scenario, PhysicalAction.UP, identities.getValue(SemanticControl.SECONDARY), 701, time++)
            awaitCapturePhase(scenario, HidBindingCapturePhase.COMMITTED)

            // Idempotent same-control/same-identity binding keeps the revision.
            val beforeIdempotent = hidProfile(scenario).revision
            scenario.onActivity {
                it.startHidBindingCaptureForTest(SemanticControl.PRIMARY, "same")
            }
            awaitCapturePhase(scenario, HidBindingCapturePhase.AWAITING_DOWN)
            inject(scenario, PhysicalAction.DOWN, identities.getValue(SemanticControl.PRIMARY), 702, time++)
            inject(scenario, PhysicalAction.UP, identities.getValue(SemanticControl.PRIMARY), 702, time++)
            awaitCapturePhase(scenario, HidBindingCapturePhase.COMMITTED)
            assertEquals(beforeIdempotent, hidProfile(scenario).revision)

            // Replacement swaps the authoritative mapping.
            val replacement = identity(SemanticControl.PRIMARY, 1)
            scenario.onActivity {
                it.startHidBindingCaptureForTest(SemanticControl.PRIMARY, "replace")
            }
            awaitCapturePhase(scenario, HidBindingCapturePhase.AWAITING_DOWN)
            inject(scenario, PhysicalAction.DOWN, replacement, 703, time++)
            inject(scenario, PhysicalAction.UP, replacement, 703, time++)
            awaitCapturePhase(scenario, HidBindingCapturePhase.COMMITTED)
            profile = hidProfile(scenario)
            assertEquals(7, profile.bindings.size)
            assertNull(profile.controlFor(identities.getValue(SemanticControl.PRIMARY)))
            assertEquals(SemanticControl.PRIMARY, profile.controlFor(replacement))

            // Disconnect cancels an in-flight mapped DOWN; late UP is inert.
            disconnectLateUp(scenario, replacement, 888, time++)

            // Built-in UP/DOWN composites and COMMAND broadcasts coexist with HID.
            builtInCoexistence(scenario)

            // Park Config focus on a foldable/no-action row so the HID PRIMARY
            // semantic press cannot re-open a binding capture during the gate.
            navUpUntil(scenario, "Workspaces", 14_000)

            // Complete production semantic gate on the persisted profile.
            semanticGate(scenario, hidProfile(scenario), time)

            // Process-level persistence proof plus Activity recreation.
            val diskProfile = persistedProfile()
            assertEquals(hidProfile(scenario), diskProfile)
            ProbeState.reset()
            scenario.recreate()
            awaitWebReady(scenario)
            profile = hidProfile(scenario)
            assertEquals(7, profile.bindings.size)
            assertEquals(hidProfile(scenario), diskProfile)
            assertEquals(HidBindingCapturePhase.IDLE, captureSnapshot(scenario).phase)
            assertNull(captureSnapshot(scenario).requestId)
            // mapping resolves under a different runtime deviceId after restart
            val remappedPrimary = profile.bindings.getValue(SemanticControl.PRIMARY)
            ProbeState.reset()
            inject(scenario, PhysicalAction.DOWN, remappedPrimary, 999, 20_000)
            assertEquals(SemanticAction.BEGIN, awaitReceipt(SemanticAction.BEGIN, SemanticControl.PRIMARY).action)
            inject(scenario, PhysicalAction.UP, remappedPrimary, 999, 20_050)
            assertEquals(SemanticAction.END, awaitReceipt(SemanticAction.END, SemanticControl.PRIMARY).action)
            assertEquals(0, ProbeState.rendererGone)
        }
    }

    private fun disconnectLateUp(
        scenario: ActivityScenario<MainActivity>,
        identity: HidPhysicalIdentity,
        deviceId: Int,
        time: Long,
    ) {
        ProbeState.reset()
        inject(scenario, PhysicalAction.DOWN, identity, deviceId, time)
        val begin = awaitReceipt(SemanticAction.BEGIN, SemanticControl.PRIMARY)
        ProbeState.reset()
        scenario.onActivity { it.removeHidInputDeviceForTest(deviceId) }
        val cancel = awaitReceipt(SemanticAction.CANCEL, SemanticControl.PRIMARY)
        assertEquals(begin.interactionId, cancel.interactionId)
        ProbeState.reset()
        inject(scenario, PhysicalAction.UP, identity, deviceId, time + 50)
        awaitNoReceipt()
    }

    private fun builtInCoexistence(scenario: ActivityScenario<MainActivity>) {
        ProbeState.reset()
        scenario.onActivity {
            repeatBuiltInKey(it, 83, 10_000)
            repeatBuiltInKey(it, 21, 10_002)
            repeatBuiltInKey(it, 19, 10_004)
        }
        awaitReceipt(SemanticAction.END, SemanticControl.UP)
        ProbeState.reset()
        scenario.onActivity {
            repeatBuiltInKey(it, 83, 11_000)
            repeatBuiltInKey(it, 22, 11_002)
            repeatBuiltInKey(it, 20, 11_004)
        }
        awaitReceipt(SemanticAction.END, SemanticControl.DOWN)
        ProbeState.reset()
        scenario.onActivity {
            it.submitBuiltInBroadcastForTest(BuiltInInputTracker.ACTION_SPRITE_BUTTON_UP, 12_000)
        }
        awaitReceipt(SemanticAction.END, SemanticControl.COMMAND)
        ProbeState.reset()
        scenario.onActivity {
            it.submitBuiltInBroadcastForTest(BuiltInInputTracker.ACTION_SPRITE_BUTTON_LONG_PRESS, 13_000)
        }
        awaitReceipt(SemanticAction.END, SemanticControl.COMMAND)
    }

    private fun semanticGate(
        scenario: ActivityScenario<MainActivity>,
        profile: HidBindingProfile,
        start: Long,
    ) {
        var time = start
        profile.bindings.forEach { (control, identity) ->
            if (control == SemanticControl.SECONDARY) return@forEach
            val deviceId = 800 + control.ordinal
            ProbeState.reset()
            inject(scenario, PhysicalAction.DOWN, identity, deviceId, time++)
            val begin = awaitReceipt(SemanticAction.BEGIN, control)
            inject(scenario, PhysicalAction.UP, identity, deviceId, time++)
            val end = awaitReceipt(SemanticAction.END, control)
            assertEquals(begin.interactionId, end.interactionId)
        }

        // Long classification still happens after mapping (advance path).
        val primary = profile.bindings.getValue(SemanticControl.PRIMARY)
        ProbeState.reset()
        val longDown = time++
        inject(scenario, PhysicalAction.DOWN, primary, 810, longDown)
        awaitReceipt(SemanticAction.BEGIN, SemanticControl.PRIMARY)
        scenario.onActivity { it.advanceInputForTest(longDown + 601) }
        awaitReceipt(SemanticAction.LONG, SemanticControl.PRIMARY)
        inject(scenario, PhysicalAction.UP, primary, 810, time++)
        awaitReceipt(SemanticAction.END, SemanticControl.PRIMARY)

        // Double SECONDARY remains the native HUD-hide operation; wake consumes one press.
        val secondary = profile.bindings.getValue(SemanticControl.SECONDARY)
        val wakeDevice = 820
        ProbeState.reset()
        inject(scenario, PhysicalAction.DOWN, secondary, wakeDevice, time++)
        inject(scenario, PhysicalAction.UP, secondary, wakeDevice, time++)
        inject(scenario, PhysicalAction.DOWN, secondary, wakeDevice, time++)
        inject(scenario, PhysicalAction.UP, secondary, wakeDevice, time++)
        awaitNoReceipt()
        inject(scenario, PhysicalAction.DOWN, primary, wakeDevice, time++)
        awaitNoReceipt()
        inject(scenario, PhysicalAction.UP, primary, wakeDevice, time++)
        awaitNoReceipt()
        inject(scenario, PhysicalAction.DOWN, primary, wakeDevice, time++)
        awaitReceipt(SemanticAction.BEGIN, SemanticControl.PRIMARY)
        inject(scenario, PhysicalAction.UP, primary, wakeDevice, time++)
        awaitReceipt(SemanticAction.END, SemanticControl.PRIMARY)
    }

    private fun repeatBuiltInKey(activity: MainActivity, keyCode: Int, time: Long) {
        activity.submitBuiltInKeyForTest(keyCode, PhysicalAction.DOWN, time)
        activity.submitBuiltInKeyForTest(keyCode, PhysicalAction.UP, time + 1)
    }

    private fun openConfig(scenario: ActivityScenario<MainActivity>) {
        scenario.onActivity {
            it.emitForTest(SemanticInteraction(SemanticControl.COMMAND, SemanticAction.LONG, 900, 900))
        }
        awaitDestination(scenario, "config")
    }

    private fun nav(scenario: ActivityScenario<MainActivity>, time: Long) {
        press(scenario, SemanticControl.DOWN, PhysicalAction.DOWN, time)
        press(scenario, SemanticControl.DOWN, PhysicalAction.UP, time + 1)
    }

    private fun activate(scenario: ActivityScenario<MainActivity>, time: Long) {
        press(scenario, SemanticControl.PRIMARY, PhysicalAction.DOWN, time)
        press(scenario, SemanticControl.PRIMARY, PhysicalAction.UP, time + 1)
    }

    private fun press(
        scenario: ActivityScenario<MainActivity>,
        control: SemanticControl,
        action: PhysicalAction,
        time: Long,
    ) {
        scenario.onActivity {
            // Use real uptime so the classifier's long-press watchdog does not
            // fire before the bridge delivers the paired UP in the same window.
            it.submitPhysicalInputForTest(
                PhysicalInput(OWNER, control, action, SystemClock.uptimeMillis()),
            )
        }
    }

    private fun inject(
        scenario: ActivityScenario<MainActivity>,
        action: PhysicalAction,
        identity: HidPhysicalIdentity,
        deviceId: Int,
        time: Long,
    ) {
        scenario.onActivity {
            it.submitHidBindingInputForTest(HidRawInput(action, identity, deviceId, 0, time, time))
        }
    }

    private fun awaitCapturePhase(
        scenario: ActivityScenario<MainActivity>,
        expected: HidBindingCapturePhase,
    ) {
        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline) {
            if (captureSnapshot(scenario).phase == expected) return
            Thread.sleep(50)
        }
        throw AssertionError("HID capture never became $expected")
    }

    private fun captureSnapshot(scenario: ActivityScenario<MainActivity>): HidBindingCaptureSnapshot {
        var snapshot = HidBindingCaptureSnapshot(null, null, HidBindingCapturePhase.IDLE, 0)
        scenario.onActivity { snapshot = it.hidCaptureSnapshotForTest() }
        return snapshot
    }

    private fun hidProfile(scenario: ActivityScenario<MainActivity>): HidBindingProfile {
        var profile = HidBindingProfile()
        scenario.onActivity { profile = it.hidProfileForTest() }
        return profile
    }

    private fun awaitFocused(scenario: ActivityScenario<MainActivity>, label: String) {
        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline) {
            if (focusedLabel(scenario) == label) return
            Thread.sleep(50)
        }
        throw AssertionError("Focused Config row never became $label")
    }

    private fun navUntil(
        scenario: ActivityScenario<MainActivity>,
        label: String,
        start: Long,
    ): Long {
        var time = start
        var attempts = 0
        while (attempts++ < 40) {
            if (focusedLabel(scenario) == label) return time
            nav(scenario, time++)
        }
        val rows = evaluate(
            scenario,
            "Array.from(document.querySelectorAll('.config-row .config-label')).map(e => e.textContent).join(' | ')",
        )
        val focused = evaluate(
            scenario,
            "(() => { const r = document.querySelector('.config-row.focused'); return r ? r.querySelector('.config-fold')?.textContent + ':' + r.getAttribute('aria-expanded') : 'none' })()",
        )
        val configDiagnostics = evaluate(
            scenario,
            "JSON.stringify(window.glasseoDiagnostics?.config ?? null)",
        )
        throw AssertionError(
            "Config row '$label' never became focused; rows=$rows focused=$focused config=$configDiagnostics",
        )
    }

    private fun navUpUntil(
        scenario: ActivityScenario<MainActivity>,
        label: String,
        start: Long,
    ): Long {
        var time = start
        var attempts = 0
        while (attempts++ < 40) {
            if (focusedLabel(scenario) == label) return time
            press(scenario, SemanticControl.UP, PhysicalAction.DOWN, time++)
            press(scenario, SemanticControl.UP, PhysicalAction.UP, time++)
        }
        throw AssertionError("Config row '$label' never became focused")
    }

    private fun focusedLabel(scenario: ActivityScenario<MainActivity>): String =
        evaluate(scenario, "document.querySelector('.config-row.focused .config-label')?.textContent ?? ''")

    private fun awaitDestination(scenario: ActivityScenario<MainActivity>, destination: String) {
        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline) {
            if (evaluate(scenario, "window.glasseoDiagnostics?.destination ?? ''") == destination) return
            Thread.sleep(50)
        }
        throw AssertionError("Destination never became $destination")
    }

    private fun awaitReceipt(
        action: SemanticAction,
        control: SemanticControl,
        timeoutSeconds: Long = 10,
    ): BridgeMessage.SemanticReceived {
        val deadline = System.currentTimeMillis() + timeoutSeconds * 1_000
        while (System.currentTimeMillis() < deadline) {
            val receipt = ProbeState.semanticReceipt
            if (receipt != null && receipt.action == action && receipt.control == control) return receipt
            Thread.sleep(20)
        }
        throw AssertionError("No semantic receipt $action/$control")
    }

    private fun awaitNoReceipt() {
        Thread.sleep(300)
        assertNull(ProbeState.semanticReceipt)
    }

    private fun persistedProfile(): HidBindingProfile? {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val raw = context.getSharedPreferences("hid-bindings", Context.MODE_PRIVATE).getString("profile", null)
        return raw?.let { runCatching { HidBindingProfileCodec.decode(it) }.getOrNull() }
    }

    private fun awaitWebReady(scenario: ActivityScenario<MainActivity>) {
        val deadline = System.currentTimeMillis() + 20_000
        while (System.currentTimeMillis() < deadline) {
            if (ProbeState.helloCount > 0 && webIsReady(scenario)) return
            Thread.sleep(50)
        }
        throw AssertionError("WebView did not become ready")
    }

    private fun webIsReady(scenario: ActivityScenario<MainActivity>): Boolean {
        var ready = false
        scenario.onActivity { ready = it.webIsReadyForTest() }
        return ready
    }

    private fun evaluate(scenario: ActivityScenario<MainActivity>, script: String): String {
        val latch = CountDownLatch(1)
        var result = ""
        scenario.onActivity { activity ->
            activity.evaluateJavascriptForTest(script) {
                result = JSONObject("{\"value\":$it}").getString("value")
                latch.countDown()
            }
        }
        assertTrue("JavaScript timed out", latch.await(10, TimeUnit.SECONDS))
        return result
    }

    private fun awaitResult(scenario: ActivityScenario<MainActivity>): JSONObject {
        val deadline = System.currentTimeMillis() + 20_000
        while (System.currentTimeMillis() < deadline) {
            val latch = CountDownLatch(1)
            var result = ""
            scenario.onActivity { activity ->
                activity.evaluateJavascriptForTest("document.body.dataset.configHidUi || ''") {
                    result = JSONObject("{\"value\":$it}").getString("value")
                    latch.countDown()
                }
            }
            assertTrue("JavaScript timed out", latch.await(10, TimeUnit.SECONDS))
            if (result.startsWith("ok:")) return JSONObject(result.removePrefix("ok:"))
            if (result.startsWith("error:")) throw AssertionError(result)
            Thread.sleep(50)
        }
        throw AssertionError("Config HID UI acceptance did not report")
    }

    private fun identity(control: SemanticControl, variant: Int) =
        HidPhysicalIdentity(
            "test-device",
            1406,
            8199,
            96 + control.ordinal + variant * 8,
            304 + 96 + control.ordinal + variant * 8,
            0x1000511,
        )

    private fun jsonContains(array: org.json.JSONArray, value: String): Boolean {
        for (index in 0 until array.length()) {
            if (array.getString(index) == value) return true
        }
        return false
    }

    companion object {
        private val OWNER = PhysicalOwner(PhysicalSource.BUILT_IN, -1, 20)
        private val SCRIPT = """
            import('./config/hid/ui-acceptance-entry.js')
              .then(() => window.__glasseoConfigHidAcceptance.run())
              .then(result => document.body.dataset.configHidUi = 'ok:' + JSON.stringify(result))
              .catch(error => document.body.dataset.configHidUi = 'error:' + String(error))
        """.trimIndent()
    }
}
