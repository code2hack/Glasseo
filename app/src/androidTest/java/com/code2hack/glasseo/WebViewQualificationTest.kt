package com.code2hack.glasseo

import android.content.Intent
import android.util.DisplayMetrics
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
                    setOf(QualificationStep.SHORT_COMMAND, QualificationStep.LONG_COMMAND),
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

    private fun shortCommand() = operation(BehaviorClass.SHORT, "com.android.action.ACTION_SPRITE_BUTTON_UP")
    private fun longCommand() = operation(BehaviorClass.LONG, "com.android.action.ACTION_SPRITE_BUTTON_LONG_PRESS")

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
