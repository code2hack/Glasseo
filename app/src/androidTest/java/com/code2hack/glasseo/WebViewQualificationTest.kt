package com.code2hack.glasseo

import android.content.Intent
import android.util.DisplayMetrics
import android.view.InputDevice
import android.view.KeyEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class WebViewQualificationTest {
    @Before fun resetProbe() = ProbeState.reset()

    @Test fun physicalWebViewPassesCompatibilityAndSecurityProbe() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val metrics = DisplayMetrics()
                activity.display?.getRealMetrics(metrics)
                assertEquals(480, metrics.widthPixels)
                assertEquals(640, metrics.heightPixels)
            }
            val result = ProbeState.await(60)
            assertNotNull("WebView probe did not report", result)
            assertEquals(BridgeMessage.REQUIRED_CHECKS, result?.checks?.keys)
            assertEquals(BridgeMessage.REQUIRED_CHECKS, result?.details?.keys)
            assertTrue("Failed checks: ${result?.details}", result?.isPassing() == true)
            assertEquals(1, ProbeState.helloCount)
            assertTrue("Remote main-frame navigation was not rejected", ProbeState.blockedNavigations >= 1)
            assertEquals("WebView renderer was lost", 0, ProbeState.rendererGone)
            scenario.onActivity { activity ->
                activity.emitForTest(
                    SemanticInteraction(SemanticControl.PRIMARY, SemanticAction.SHORT, 42, 123),
                )
            }
            assertEquals(
                BridgeMessage.SemanticReceived(SemanticControl.PRIMARY, SemanticAction.SHORT, 42),
                ProbeState.awaitSemanticReceipt(10),
            )
        }
    }

    @Test fun orderedInterceptionStartsWithProcessAndSurvivesActivityRecreation() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var application: GlasseoApplication
            lateinit var interception: PersistentOrderedBroadcastInterception
            scenario.onActivity { activity ->
                application = activity.application as GlasseoApplication
                interception = application.orderedInterception
                assertTrue(interception.started)
            }

            scenario.recreate()

            scenario.onActivity { activity ->
                assertTrue(activity.application === application)
                assertTrue((activity.application as GlasseoApplication).orderedInterception === interception)
                assertTrue(interception.started)
            }
        }
    }

    @Test fun realBridgeRendersAndAcknowledgesShortCommandThroughLongCommandToUp() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            assertNotNull(ProbeState.await(60))
            scenario.onActivity { it.startQualificationForTest(QualificationStep.SHORT_COMMAND) }
            awaitState(scenario, QualificationStep.SHORT_COMMAND, QualificationPhase.AWAITING_FIRST, armed = true)
            assertEquals("5/10 Short COMMAND|Perform the intended action", readDom(scenario))

            submit(scenario, shortCommand())
            awaitRendered(QualificationStep.SHORT_COMMAND, QualificationPhase.SETTLING_FIRST)
            submitAfterReady(scenario, QualificationStep.SHORT_COMMAND, shortCommand())
            awaitRendered(QualificationStep.SHORT_COMMAND, QualificationPhase.SETTLING_SECOND)
            awaitState(scenario, QualificationStep.LONG_COMMAND, QualificationPhase.AWAITING_FIRST, armed = true)
            assertEquals("6/10 Long COMMAND|Perform the intended action", readDom(scenario))

            submit(scenario, longCommand())
            awaitRendered(QualificationStep.LONG_COMMAND, QualificationPhase.SETTLING_FIRST)
            submitAfterReady(scenario, QualificationStep.LONG_COMMAND, longCommand())
            awaitRendered(QualificationStep.LONG_COMMAND, QualificationPhase.SETTLING_SECOND)
            awaitState(scenario, QualificationStep.UP, QualificationPhase.AWAITING_FIRST, armed = true)
            assertEquals("7/10 UP|Perform the intended action", readDom(scenario))
        }
    }

    @Test fun recreationAndReloadReplayCurrentRevisionBeforeRearming() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            assertNotNull(ProbeState.await(60))
            scenario.onActivity { it.startQualificationForTest(QualificationStep.SHORT_COMMAND) }
            val before = awaitState(
                scenario,
                QualificationStep.SHORT_COMMAND,
                QualificationPhase.AWAITING_FIRST,
                armed = true,
            )

            scenario.recreate()
            val recreated = awaitState(
                scenario,
                QualificationStep.SHORT_COMMAND,
                QualificationPhase.AWAITING_FIRST,
                armed = true,
            )
            assertEquals(before.sessionId, recreated.sessionId)
            assertEquals(before.revision, recreated.revision)

            scenario.onActivity {
                it.reloadQualificationForTest()
                assertFalse((it.application as GlasseoApplication).qualificationSession!!.armed)
            }
            val reloaded = awaitState(
                scenario,
                QualificationStep.SHORT_COMMAND,
                QualificationPhase.AWAITING_FIRST,
                armed = true,
            )
            assertEquals(before.revision, reloaded.revision)
            assertEquals("5/10 Short COMMAND|Perform the intended action", readDom(scenario))
        }
    }

    @Test fun pausedTargetSurvivesRecoveryInterceptsInputAndRequiresDebugResume() {
        val launchIntent = Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
            .putExtra(MainActivity.INPUT_CAPTURE_EXTRA, true)
            .putExtra(MainActivity.QUALIFICATION_PAUSE_STEP_EXTRA, QualificationStep.UP.name)
        ActivityScenario.launch<MainActivity>(launchIntent).use { scenario ->
            assertNotNull(ProbeState.await(60))
            lateinit var application: GlasseoApplication
            scenario.onActivity {
                application = it.application as GlasseoApplication
                it.startQualificationForTest(QualificationStep.UP)
                assertEquals(
                    setOf(
                        QualificationStep.SHORT_COMMAND,
                        QualificationStep.LONG_COMMAND,
                        QualificationStep.UP,
                        QualificationStep.DOWN,
                    ),
                    application.qualificationSession!!.wizard.results.keys,
                )
            }
            val paused = awaitState(
                scenario,
                QualificationStep.UP,
                QualificationPhase.AWAITING_FIRST,
                armed = false,
                paused = true,
            )
            assertEquals("7/10 UP|${QualificationSession.PAUSED_PROMPT}", readDom(scenario))

            scenario.onActivity {
                assertTrue(application.orderedInterception.started)
                assertFalse(it.submitQualificationForTest(longCommand()))
            }
            assertEquals(
                paused.revision,
                awaitState(
                    scenario,
                    QualificationStep.UP,
                    QualificationPhase.AWAITING_FIRST,
                    armed = false,
                    paused = true,
                ).revision,
            )

            scenario.onActivity { it.reloadQualificationForTest() }
            assertEquals(
                paused.revision,
                awaitState(
                    scenario,
                    QualificationStep.UP,
                    QualificationPhase.AWAITING_FIRST,
                    armed = false,
                    paused = true,
                ).revision,
            )

            scenario.recreate()
            assertTrue((application.orderedInterception.started))
            assertEquals(
                paused.revision,
                awaitState(
                    scenario,
                    QualificationStep.UP,
                    QualificationPhase.AWAITING_FIRST,
                    armed = false,
                    paused = true,
                ).revision,
            )

            ActivityScenario.launch<MainActivity>(
                Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
                    .putExtra(MainActivity.QUALIFICATION_RESUME_EXTRA, true),
            ).use { resumedScenario ->
                val resumed = awaitState(
                    resumedScenario,
                    QualificationStep.UP,
                    QualificationPhase.AWAITING_FIRST,
                    armed = true,
                    paused = false,
                )
                assertEquals(paused.revision + 1, resumed.revision)
                assertEquals("7/10 UP|Perform the intended action", readDom(resumedScenario))
            }
        }
    }

    @Test fun hidFocusLossCancelsActivePressAndRearmsFreshInputAfterExactAck() {
        val launchIntent = Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
            .putExtra(MainActivity.INPUT_CAPTURE_EXTRA, true)
        ActivityScenario.launch<MainActivity>(launchIntent).use { scenario ->
            assertNotNull(ProbeState.await(60))
            val identity = hidIdentity(1)
            scenario.onActivity { it.startHidQualificationForTest(identity.peripheral) }
            val ready = awaitHidState(scenario, HidQualificationStage.BINDING, 0, armed = true)
            val downAt = android.os.SystemClock.uptimeMillis()
            scenario.onActivity {
                it.submitHidInputForTest(
                    HidRawInput(PhysicalAction.DOWN, identity, 90, 0, downAt, downAt),
                )
                it.onWindowFocusChanged(false)
                assertFalse((it.application as GlasseoApplication).hidQualificationFlow!!.isArmed)
            }

            scenario.onActivity { it.onWindowFocusChanged(true) }
            val rearmed = awaitHidState(scenario, HidQualificationStage.BINDING, 0, armed = true)
            assertEquals(ready.sessionId, rearmed.sessionId)
            assertTrue(rearmed.revision > ready.revision)

            scenario.onActivity {
                it.submitHidInputForTest(
                    HidRawInput(PhysicalAction.UP, identity, 90, 0, downAt + 100, downAt + 100),
                )
            }
            assertEquals(
                rearmed.revision,
                awaitHidState(scenario, HidQualificationStage.BINDING, 0, armed = true).revision,
            )

            val freshDownAt = downAt + 200
            submitHidCycle(scenario, identity, freshDownAt, 100)
            awaitHidState(scenario, HidQualificationStage.BINDING, 1, armed = true)
        }
    }

    @Test fun physicalSecondaryDoubleSurvivesReloadAndCancelsVisiblyOnRecreation() {
        val launchIntent = Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
            .putExtra(MainActivity.INPUT_CAPTURE_EXTRA, true)
        ActivityScenario.launch<MainActivity>(launchIntent).use { scenario ->
            assertNotNull(ProbeState.await(60))
            val identities = (1..7).map(::hidIdentity)
            scenario.onActivity { it.startHidQualificationForTest(identities.first().peripheral) }
            var time = android.os.SystemClock.uptimeMillis()
            identities.forEachIndexed { index, identity ->
                awaitHidState(scenario, HidQualificationStage.BINDING, index, armed = true)
                submitHidCycle(scenario, identity, time, 20)
                time += 1_000
            }
            listOf(identities[0] to 20L, identities[0] to 700L, identities[1] to 700L)
                .forEachIndexed { index, (identity, duration) ->
                    awaitHidState(scenario, HidQualificationStage.RECOGNITION, index, armed = true)
                    submitHidCycle(scenario, identity, time, duration)
                    time += 1_000
                }

            val before = awaitHidState(scenario, HidQualificationStage.RECOGNITION, 3, armed = true)
            submitHidCycle(scenario, identities[1], time, 20)
            val pending = awaitHidState(scenario, HidQualificationStage.RECOGNITION, 3, armed = true)
            assertEquals(before.revision, pending.revision)
            assertTrue(awaitHidTrace(scenario, "waiting for second cycle").contains("UP keyCode=${identities[1].keyCode}"))

            scenario.onActivity { it.reloadQualificationForTest() }
            val reloaded = awaitHidState(scenario, HidQualificationStage.RECOGNITION, 3, armed = true)
            assertEquals(pending.revision, reloaded.revision)
            scenario.onActivity {
                assertTrue((it.application as GlasseoApplication).hidQualificationFlow!!.hasPendingInput)
            }

            scenario.recreate()
            val recreated = awaitHidState(scenario, HidQualificationStage.RECOGNITION, 3, armed = true)
            assertTrue(recreated.revision > reloaded.revision)
            assertEquals("Input cancelled: pause", recreated.error)

            submitHidCycle(scenario, identities[1], time + 240, 20)
            assertEquals(
                recreated.revision,
                awaitHidState(scenario, HidQualificationStage.RECOGNITION, 3, armed = true).revision,
            )
            submitHidCycle(scenario, identities[1], time + 360, 20)
            awaitHidState(scenario, HidQualificationStage.RECOGNITION, 4, armed = true)
            scenario.onActivity {
                val result = (it.application as GlasseoApplication).hidQualificationFlow!!.operations
                    .getValue(QualificationStep.DOUBLE_SECONDARY)
                assertEquals(1, result.hidCaptures.size)
                assertEquals(2, result.hidCaptures.single().size)
            }
        }
    }

    @Test fun hidReloadAndRecreationReplayThenAckBeforeRearmingWhileInterceptionStaysActive() {
        val launchIntent = Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
            .putExtra(MainActivity.INPUT_CAPTURE_EXTRA, true)
        ActivityScenario.launch<MainActivity>(launchIntent).use { scenario ->
            assertNotNull(ProbeState.await(60))
            lateinit var application: GlasseoApplication
            val identity = hidIdentity(1)
            scenario.onActivity {
                application = it.application as GlasseoApplication
                it.startHidQualificationForTest(identity.peripheral)
            }
            val before = awaitHidState(scenario, HidQualificationStage.BINDING, 0, armed = true)
            assertTrue(application.orderedInterception.started)

            scenario.onActivity { it.reloadQualificationForTest() }
            assertEquals(
                before.revision,
                awaitHidState(scenario, HidQualificationStage.BINDING, 0, armed = true).revision,
            )

            scenario.recreate()
            assertTrue(application.orderedInterception.started)
            assertEquals(
                before.revision,
                awaitHidState(scenario, HidQualificationStage.BINDING, 0, armed = true).revision,
            )
        }
    }

    @Test fun hidBridgeBindsSevenShortCyclesThenRecognizesTenOperationsWithoutSettle() {
        val launchIntent = Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
            .putExtra(MainActivity.INPUT_CAPTURE_EXTRA, true)
        ActivityScenario.launch<MainActivity>(launchIntent).use { scenario ->
            assertNotNull(ProbeState.await(60))
            val primary = hidIdentity(1)
            val secondary = hidIdentity(2)
            val command = hidIdentity(3)
            val directions = (4..7).map(::hidIdentity)
            val bindings = listOf(
                primary,
                secondary,
                command,
                directions[0],
                directions[1],
                directions[2],
                directions[3],
            )
            scenario.onActivity { it.startHidQualificationForTest(primary.peripheral) }
            awaitHidState(scenario, HidQualificationStage.BINDING, 0, armed = true)
            assertEquals("1/7 Bind PRIMARY|Press the button you wanna bind", readDom(scenario))
            var time = 1_000L
            bindings.forEachIndexed { index, identity ->
                awaitHidState(scenario, HidQualificationStage.BINDING, index, armed = true)
                submitHidCycle(scenario, identity, time, listOf(2L, 20L, 80L, 150L, 300L)[index % 5])
                time += 1_000
            }

            val recognized = listOf(
                primary to 20L,
                primary to 700L,
                secondary to 700L,
                secondary to 20L,
                command to 20L,
                command to 700L,
                directions[0] to 20L,
                directions[1] to 20L,
                directions[2] to 20L,
                directions[3] to 20L,
            )
            recognized.forEachIndexed { index, (identity, duration) ->
                awaitHidState(scenario, HidQualificationStage.RECOGNITION, index, armed = true)
                submitHidCycle(scenario, identity, time, duration)
                if (index == QualificationStep.DOUBLE_SECONDARY.ordinal) {
                    time += duration + 100
                    submitHidCycle(scenario, identity, time, duration)
                }
                time += 1_000
            }
            awaitHidState(scenario, HidQualificationStage.COMPLETE, 10, armed = false)

            scenario.onActivity {
                val application = it.application as GlasseoApplication
                val result = application.hidQualificationFlow!!.result()
                assertTrue(result?.passes == true)
                assertEquals(7, result?.bindings?.size)
                assertEquals(10, result?.operations?.size)
                assertEquals(0, application.hidInputTrace.snapshot().droppedRecords)
                assertTrue(application.orderedInterception.started)
            }
        }
    }

    @Test fun connectedJoyConDispatchEntryRetainsNoRepeatTwoToThreeHundredMillisecondPairs() {
        val launchIntent = Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
            .putExtra(MainActivity.INPUT_CAPTURE_EXTRA, true)
        ActivityScenario.launch<MainActivity>(launchIntent).use { scenario ->
            assertNotNull(ProbeState.await(60))
            val device = InputDevice.getDeviceIds().asSequence()
                .mapNotNull(InputDevice::getDevice)
                .first { it.isExternal && it.vendorId == 1406 && it.productId == 8199 }
            val peripheral = HidPeripheralIdentity(device.descriptor, device.vendorId, device.productId, device.sources)
            val durations = listOf(2L, 20L, 80L, 150L, 300L)
            var time = android.os.SystemClock.uptimeMillis()
            durations.forEach { duration ->
                scenario.onActivity { it.startHidQualificationForTest(peripheral) }
                repeat(7) { index ->
                    awaitHidState(scenario, HidQualificationStage.BINDING, index, armed = true)
                    dispatchHidCycle(scenario, device, 96 + index, 304 + index, time, duration)
                    time += 1_000
                }
                awaitHidState(scenario, HidQualificationStage.RECOGNITION, 0, armed = true)
                dispatchHidCycle(scenario, device, 96, 304, time, duration)
                time += 1_000

                scenario.onActivity {
                    val application = it.application as GlasseoApplication
                    val trace = application.hidInputTrace
                    assertEquals(16, trace.allRawReceipts().size)
                    assertEquals(16, trace.allDecisions().size)
                    assertTrue(trace.allRawReceipts().all { receipt -> receipt.repeatCount == 0 })
                    assertEquals(BehaviorClass.SHORT, application.hidQualificationFlow!!.operations
                        .getValue(QualificationStep.SHORT_PRIMARY).step.behavior)
                    assertEquals(0, trace.snapshot().droppedRecords)
                }
            }
        }
    }

    private fun submitAfterReady(
        scenario: ActivityScenario<MainActivity>,
        step: QualificationStep,
        operation: QualificationOperation,
    ) {
        awaitState(scenario, step, QualificationPhase.AWAITING_CONFIRMATION, armed = true)
        submit(scenario, operation)
    }

    private fun submit(scenario: ActivityScenario<MainActivity>, operation: QualificationOperation) {
        scenario.onActivity { assertTrue(it.submitQualificationForTest(operation)) }
    }

    private fun submitHidCycle(
        scenario: ActivityScenario<MainActivity>,
        identity: HidPhysicalIdentity,
        downAt: Long,
        duration: Long,
    ) {
        scenario.onActivity {
            it.submitHidInputForTest(
                HidRawInput(PhysicalAction.DOWN, identity, 6, 0, downAt, downAt),
            )
            it.submitHidInputForTest(
                HidRawInput(PhysicalAction.UP, identity, 6, 0, downAt + duration, downAt + duration),
            )
        }
    }

    private fun dispatchHidCycle(
        scenario: ActivityScenario<MainActivity>,
        device: InputDevice,
        keyCode: Int,
        scanCode: Int,
        downAt: Long,
        duration: Long,
    ) {
        scenario.onActivity { activity ->
            activity.dispatchKeyEvent(
                KeyEvent(downAt, downAt, KeyEvent.ACTION_DOWN, keyCode, 0, 0, device.id, scanCode, 0, device.sources),
            )
            activity.dispatchKeyEvent(
                KeyEvent(
                    downAt,
                    downAt + duration,
                    KeyEvent.ACTION_UP,
                    keyCode,
                    0,
                    0,
                    device.id,
                    scanCode,
                    0,
                    device.sources,
                ),
            )
        }
    }

    private fun awaitHidState(
        scenario: ActivityScenario<MainActivity>,
        stage: HidQualificationStage,
        stepIndex: Int,
        armed: Boolean,
    ): HidQualificationSnapshot {
        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline) {
            var snapshot: HidQualificationSnapshot? = null
            var isArmed = false
            scenario.onActivity {
                val flow = (it.application as GlasseoApplication).hidQualificationFlow
                snapshot = flow?.snapshot
                isArmed = flow?.isArmed == true
            }
            if (snapshot?.stage == stage && snapshot?.stepIndex == stepIndex && isArmed == armed) return snapshot!!
            Thread.sleep(50)
        }
        throw AssertionError("HID state did not reach $stage step=$stepIndex armed=$armed")
    }

    private fun awaitRendered(step: QualificationStep, phase: QualificationPhase) {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            if (ProbeState.qualificationRenders.any { it.stepIndex == step.ordinal && it.phase == phase }) return
            Thread.sleep(50)
        }
        throw AssertionError("Web did not acknowledge $step $phase: ${ProbeState.qualificationRenders}")
    }

    private fun awaitState(
        scenario: ActivityScenario<MainActivity>,
        step: QualificationStep,
        phase: QualificationPhase,
        armed: Boolean,
        paused: Boolean? = null,
    ): QualificationSnapshot {
        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline) {
            var snapshot: QualificationSnapshot? = null
            var isArmed = false
            scenario.onActivity {
                val session = (it.application as GlasseoApplication).qualificationSession
                snapshot = session?.snapshot
                isArmed = session?.armed == true
            }
            if (snapshot?.step == step && snapshot?.phase == phase && isArmed == armed &&
                (paused == null || snapshot?.paused == paused)
            ) return snapshot!!
            Thread.sleep(50)
        }
        throw AssertionError("Native state did not reach $step $phase armed=$armed")
    }

    private fun readDom(scenario: ActivityScenario<MainActivity>): String {
        val latch = CountDownLatch(1)
        var value = ""
        scenario.onActivity { activity ->
            activity.readQualificationDomForTest {
                value = JSONObject("{\"value\":$it}").getString("value")
                latch.countDown()
            }
        }
        assertTrue(latch.await(10, TimeUnit.SECONDS))
        return value
    }

    private fun readHidTrace(scenario: ActivityScenario<MainActivity>): String {
        val latch = CountDownLatch(1)
        var value = ""
        scenario.onActivity { activity ->
            activity.readHidTraceDomForTest {
                value = JSONObject("{\"value\":$it}").getString("value")
                latch.countDown()
            }
        }
        assertTrue(latch.await(10, TimeUnit.SECONDS))
        return value
    }

    private fun awaitHidTrace(scenario: ActivityScenario<MainActivity>, expected: String): String {
        val deadline = System.currentTimeMillis() + 10_000
        var trace = ""
        while (System.currentTimeMillis() < deadline) {
            trace = readHidTrace(scenario)
            if (trace.contains(expected)) return trace
            Thread.sleep(50)
        }
        throw AssertionError("HID trace did not contain $expected: $trace")
    }

    private fun shortCommand() = operation(BehaviorClass.SHORT, "com.android.action.ACTION_SPRITE_BUTTON_UP")
    private fun longCommand() = operation(BehaviorClass.LONG, "com.android.action.ACTION_SPRITE_BUTTON_LONG_PRESS")

    private fun hidIdentity(key: Int) = HidPhysicalIdentity(
        descriptor = "test-keyboard",
        vendorId = 1,
        productId = 2,
        keyCode = 60 + key,
        scanCode = 20 + key,
        sources = 0x101,
    )

    private fun hid(identity: HidPhysicalIdentity, behavior: BehaviorClass) = QualificationOperation(
        HidOperationSignature(identity, behavior),
        hidPresses = when (behavior) {
            BehaviorClass.LONG -> listOf(HidPressTiming(100, 700))
            BehaviorClass.DOUBLE -> listOf(HidPressTiming(100, 200), HidPressTiming(400, 500))
            else -> listOf(HidPressTiming(100, 200))
        },
    )

    private fun operation(behavior: BehaviorClass, action: String) = QualificationOperation(
        BuiltInOperationSignature(
            behavior,
            emptyList(),
            emptyList(),
            listOf(CapturedBroadcast(action, 0x50000010, true)),
            false,
            emptySet(),
            emptySet(),
        ),
        suppression = SuppressionOutcome.SUCCEEDED,
    )
}
