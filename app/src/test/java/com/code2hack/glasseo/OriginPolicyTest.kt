package com.code2hack.glasseo

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OriginPolicyTest {
    @Test fun allowsOnlyExactLocalHttpsOrigin() {
        assertTrue(OriginPolicy.allowsMainFrame(OriginPolicy.START_URL))
        assertFalse(OriginPolicy.allowsMainFrame("https://example.com/"))
        assertFalse(OriginPolicy.allowsMainFrame("http://appassets.androidplatform.net/assets/index.html"))
        assertFalse(OriginPolicy.allowsMainFrame("https://appassets.androidplatform.net.evil.test/"))
    }
}
