package com.code2hack.glasseo

import android.util.DisplayMetrics
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

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
        }
    }
}
