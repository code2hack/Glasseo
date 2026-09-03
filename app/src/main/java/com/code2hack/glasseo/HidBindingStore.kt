package com.code2hack.glasseo

import android.content.SharedPreferences

fun interface HidBindingPersistence {
    fun write(value: String): Boolean
}

class SharedPreferencesHidBindingPersistence(private val preferences: SharedPreferences) : HidBindingPersistence {
    fun read(): String? = preferences.getString(PROFILE_KEY, null)

    override fun write(value: String): Boolean = preferences.edit().putString(PROFILE_KEY, value).commit()

    private companion object {
        const val PROFILE_KEY = "profile"
    }
}

enum class HidBindingStatus { BOUND, UNCHANGED, DUPLICATE, INVALID, STORAGE_ERROR, RESET }

data class HidBindingMutation(
    val status: HidBindingStatus,
    val profile: HidBindingProfile,
)

class HidBindingStore(
    initialValue: String?,
    private val persistence: HidBindingPersistence,
    private val clock: () -> Long,
) {
    @Volatile
    var profile: HidBindingProfile = initialValue
        ?.let { runCatching { HidBindingProfileCodec.decode(it) }.getOrNull() }
        ?: HidBindingProfile()
        private set

    @Synchronized
    fun bind(control: SemanticControl, identity: HidPhysicalIdentity): HidBindingMutation {
        if (runCatching(identity::requirePersistable).isFailure) return mutation(HidBindingStatus.INVALID)
        val duplicate = profile.bindings.any { (otherControl, otherIdentity) ->
            otherControl != control && otherIdentity.sameControl(identity)
        }
        if (duplicate) return mutation(HidBindingStatus.DUPLICATE)
        if (profile.bindings[control]?.sameControl(identity) == true) return mutation(HidBindingStatus.UNCHANGED)
        return persist(profile.bindings + (control to identity), HidBindingStatus.BOUND)
    }

    @Synchronized
    fun reset(): HidBindingMutation = persist(emptyMap(), HidBindingStatus.RESET)

    fun controlFor(identity: HidPhysicalIdentity): SemanticControl? = profile.controlFor(identity)

    private fun persist(
        bindings: Map<SemanticControl, HidPhysicalIdentity>,
        success: HidBindingStatus,
    ): HidBindingMutation {
        val next = HidBindingProfile(
            bindings = bindings,
            revision = profile.revision + 1,
            updatedAtMillis = maxOf(profile.updatedAtMillis + 1, clock()),
        )
        if (!persistence.write(HidBindingProfileCodec.encode(next))) return mutation(HidBindingStatus.STORAGE_ERROR)
        profile = next
        return mutation(success)
    }

    private fun mutation(status: HidBindingStatus) = HidBindingMutation(status, profile)
}
