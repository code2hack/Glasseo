package com.code2hack.glasseo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InputBindingsTest {
    private val primary = HidPhysicalIdentity("keyboard", 10, 20, 66, 28)
    private val secondary = HidPhysicalIdentity("keyboard", 10, 20, 67, 14)

    @Test fun sessionBindingsUseStableIdentityAndRejectDuplicates() {
        val bindings = HidBindingMap()

        assertTrue(bindings.bind(SemanticControl.PRIMARY, primary))
        assertTrue(bindings.bind(SemanticControl.PRIMARY, primary))
        assertFalse(bindings.bind(SemanticControl.SECONDARY, primary))
        assertTrue(bindings.bind(SemanticControl.SECONDARY, secondary))

        assertEquals(SemanticControl.PRIMARY, bindings.controlFor(primary))
        assertEquals(primary, bindings.identityFor(SemanticControl.PRIMARY))
        assertNull(bindings.controlFor(primary.copy(scanCode = 29)))
        assertEquals(2, bindings.size)
    }

    @Test fun identityContainsNoEphemeralDeviceId() {
        assertEquals(
            setOf("descriptor", "vendorId", "productId", "keyCode", "scanCode"),
            HidPhysicalIdentity::class.java.declaredFields.map { it.name }.filterNot { it.startsWith("$") }.toSet(),
        )
    }
}
