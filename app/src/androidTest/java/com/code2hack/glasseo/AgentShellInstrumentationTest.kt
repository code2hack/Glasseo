package com.code2hack.glasseo

import android.util.DisplayMetrics
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
class AgentShellInstrumentationTest {
    @Before fun resetProbe() = ProbeState.reset()

    @Test fun productShellStaysWithinThePhysicalViewportWithLongUnicodeHeader() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitWebReady()
            scenario.onActivity { activity ->
                val metrics = DisplayMetrics()
                activity.display?.getRealMetrics(metrics)
                assertEquals(480, metrics.widthPixels)
                assertEquals(640, metrics.heightPixels)
            }
            val result = JSONObject(evaluate(scenario, SCRIPT))
            assertEquals(480, result.getInt("width"))
            assertEquals(640, result.getInt("height"))
            assertEquals(2, result.getInt("headerRows"))
            assertTrue(result.getInt("headerHeight") in 62..64)
            assertTrue(result.getDouble("headerBottom") <= result.getDouble("bodyTop"))
            assertTrue(result.getDouble("bodyBottom") <= result.getDouble("height"))
            assertTrue(result.getInt("documentScrollWidth") <= result.getInt("width"))
            assertEquals("hidden", result.getString("overflow"))
            assertEquals("ellipsis", result.getString("textOverflow"))
            assertEquals("nowrap", result.getString("whiteSpace"))
            assertTrue(result.getBoolean("fullTextPreserved"))
            assertTrue(result.getBoolean("stableDom"))
            assertTrue(result.getInt("renderRevision") >= 3)
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

    companion object {
        private val SCRIPT = """
            (() => {
              const line = document.querySelector('#agent-header-line-1');
              const header = document.querySelector('#agent-header');
              const body = document.querySelector('#agent-body');
              const full = '主机 · 项目 / 工作区 / Agent Ω '.repeat(40);
              line.textContent = full;
              line.title = full;
              header.setAttribute('aria-label', full);
              const headerRect = header.getBoundingClientRect();
              const bodyRect = body.getBoundingClientRect();
              const style = getComputedStyle(line);
              return JSON.stringify({
                width: innerWidth,
                height: innerHeight,
                headerRows: header.children.length,
                headerHeight: headerRect.height,
                headerBottom: headerRect.bottom,
                bodyTop: bodyRect.top,
                bodyBottom: bodyRect.bottom,
                documentScrollWidth: document.documentElement.scrollWidth,
                overflow: style.overflow,
                textOverflow: style.textOverflow,
                whiteSpace: style.whiteSpace,
                fullTextPreserved: line.title === full && header.getAttribute('aria-label') === full,
                stableDom: window.glasseoDiagnostics.stableDom,
                renderRevision: window.glasseoDiagnostics.renderRevision,
              });
            })()
        """.trimIndent()
    }
}
