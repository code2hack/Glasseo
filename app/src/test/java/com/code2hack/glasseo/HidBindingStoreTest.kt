package com.code2hack.glasseo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HidBindingStoreTest {
    private val primary = identity(96, 304)
    private val secondary = identity(97, 305)

    @Test fun bindReplaceDuplicateResetAndRestartAreAtomicAndMonotonic() {
        var persisted: String? = null
        val store = HidBindingStore(null, { value -> persisted = value; true }, { 10 })

        assertEquals(HidBindingStatus.BOUND, store.bind(SemanticControl.PRIMARY, primary).status)
        assertEquals(HidBindingStatus.DUPLICATE, store.bind(SemanticControl.SECONDARY, primary).status)
        assertEquals(1, store.profile.revision)
        assertEquals(HidBindingStatus.BOUND, store.bind(SemanticControl.PRIMARY, secondary).status)
        assertEquals(2, store.profile.revision)
        assertEquals(SemanticControl.PRIMARY, store.controlFor(secondary.copy(sources = 0x501)))

        val restarted = HidBindingStore(persisted, { true }, { 20 })
        assertEquals(store.profile, restarted.profile)
        assertEquals(HidBindingStatus.RESET, restarted.reset().status)
        assertEquals(3, restarted.profile.revision)
        assertTrue(restarted.profile.bindings.isEmpty())
    }

    @Test fun corruptionAndFailedWritesFailSafeWithoutChangingAuthoritativeMemory() {
        val store = HidBindingStore("{bad", { false }, { 1 })

        assertTrue(store.profile.bindings.isEmpty())
        assertEquals(HidBindingStatus.STORAGE_ERROR, store.bind(SemanticControl.PRIMARY, primary).status)
        assertEquals(0, store.profile.revision)
        assertNull(store.controlFor(primary))
    }

    @Test fun codecRejectsMalformedIdentityAndDuplicatePhysicalKeys() {
        val duplicate =
            """{"schemaVersion":1,"revision":1,"updatedAtMillis":1,"bindings":[""" +
                binding("PRIMARY", primary) + "," + binding("SECONDARY", primary) + "]}"
        val invalidSource = HidBindingProfile(bindings = mapOf(SemanticControl.PRIMARY to primary.copy(sources = 0)))

        assertTrue(runCatching { HidBindingProfileCodec.decode(duplicate) }.isFailure)
        assertTrue(runCatching { HidBindingProfileCodec.encode(invalidSource) }.isFailure)
    }

    private fun identity(keyCode: Int, scanCode: Int) =
        HidPhysicalIdentity("joy-con", 1406, 8199, keyCode, scanCode, 0x1000511)

    private fun binding(control: String, identity: HidPhysicalIdentity) =
        """{"control":"$control","descriptor":"${identity.descriptor}","vendorId":${identity.vendorId},"productId":${identity.productId},"sourceMask":${identity.sources},"keyCode":${identity.keyCode},"scanCode":${identity.scanCode}}"""
}
