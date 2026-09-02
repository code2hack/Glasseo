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
        if (bindings.values.firstOrNull()?.peripheral?.let { it != identity.peripheral } == true) return false
        if (bindings.any { (boundControl, boundIdentity) -> boundControl != control && boundIdentity == identity }) {
            return false
        }
        val current = bindings[control]
        if (current != null) return current == identity
        bindings[control] = identity
        return true
    }

    fun identityFor(control: SemanticControl): HidPhysicalIdentity? = bindings[control]

    fun controlFor(identity: HidPhysicalIdentity): SemanticControl? =
        bindings.entries.firstOrNull { it.value == identity }?.key

    fun snapshot(): Map<SemanticControl, HidPhysicalIdentity> = bindings.toMap()
}
