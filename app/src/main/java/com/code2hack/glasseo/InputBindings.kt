package com.code2hack.glasseo

data class HidPhysicalIdentity(
    val descriptor: String,
    val vendorId: Int,
    val productId: Int,
    val keyCode: Int,
    val scanCode: Int,
    val sources: Int = 0,
) {
    val peripheral: HidPeripheralIdentity
        get() = HidPeripheralIdentity(descriptor, vendorId, productId, sources)
}

data class HidPeripheralIdentity(
    val descriptor: String,
    val vendorId: Int,
    val productId: Int,
    val sources: Int,
)

class HidBindingMap {
    private val bindings = mutableMapOf<SemanticControl, HidPhysicalIdentity>()

    val size: Int
        get() = bindings.size

    val peripheral: HidPeripheralIdentity?
        get() = bindings.values.firstOrNull()?.peripheral

    fun bind(control: SemanticControl, identity: HidPhysicalIdentity): Boolean {
        if (bindings.values.firstOrNull()?.peripheral?.let { !it.sameDevice(identity.peripheral) } == true) return false
        if (bindings.any { (boundControl, boundIdentity) ->
                boundControl != control && boundIdentity.sameControl(identity)
            }
        ) {
            return false
        }
        val current = bindings[control]
        if (current != null) return current.sameControl(identity)
        bindings[control] = identity
        return true
    }

    fun identityFor(control: SemanticControl): HidPhysicalIdentity? = bindings[control]

    fun controlFor(identity: HidPhysicalIdentity): SemanticControl? =
        bindings.entries.firstOrNull { it.value.sameControl(identity) }?.key

    fun snapshot(): Map<SemanticControl, HidPhysicalIdentity> = bindings.toMap()

    fun clear() = bindings.clear()
}

internal fun HidPeripheralIdentity.sameDevice(other: HidPeripheralIdentity): Boolean =
    descriptor == other.descriptor && vendorId == other.vendorId && productId == other.productId

internal fun HidPhysicalIdentity.sameControl(other: HidPhysicalIdentity): Boolean =
    peripheral.sameDevice(other.peripheral) && keyCode == other.keyCode && scanCode == other.scanCode
