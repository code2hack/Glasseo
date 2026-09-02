package com.code2hack.glasseo

data class HidPhysicalIdentity(
    val descriptor: String,
    val vendorId: Int,
    val productId: Int,
    val keyCode: Int,
    val scanCode: Int,
)

class HidBindingMap {
    private val bindings = mutableMapOf<SemanticControl, HidPhysicalIdentity>()

    val size: Int
        get() = bindings.size

    fun bind(control: SemanticControl, identity: HidPhysicalIdentity): Boolean {
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
}
