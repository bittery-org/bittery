package com.bittery.mobile.credentialprovider.vault

/**
 * One account's travel-mode policy, as the native side holds it.
 *
 * Travel mode is a server-held policy: the user names the vaults to hide, and the
 * server hands every one of their devices the same answer. Its wire shape is
 * `TravelModeResponse` in `packages/api-contract/openapi.v1.json`; the app maps
 * that to `TravelModeConfig` and sends the result down with each snapshot. This
 * record reads the same three facts and adds nothing.
 *
 * No generator makes a Kotlin version. This repo generates TypeScript from
 * OpenAPI and Kotlin from the uniffi crypto core, and neither targets Kotlin from
 * OpenAPI — and the payload this is parsed from is the *app's* JSON, not the
 * server's response, so it is not the generated type anyway. That is the same
 * reason [KdfProfile] and [ReplicaVaultKey] are written here by hand. See ADR
 * 0012.
 *
 * A `null` policy is not "travel mode is off". It means nothing was verified, and
 * the vault then answers nothing for that account — see [ReplicaStore.travelModePolicy].
 */
internal data class NativeTravelModePolicy(
    val enabled: Boolean,
    val hiddenVaultIds: Set<String>,
    /** `TravelModeResponse.updatedAt`, in milliseconds. The policy's version. */
    val updatedAtMs: Long?,
) {

    /**
     * The vaults this policy suppresses right now.
     *
     * Empty while travel mode is off, whatever the list says. The server keeps the
     * chosen vaults between trips, so the switch — not the list — is the question.
     */
    val suppressedVaultIds: Set<String>
        get() = if (enabled) hiddenVaultIds else emptySet()

    /** Whether this policy suppresses a vault. The whole rule, in one line. */
    fun hides(vaultId: String): Boolean = enabled && vaultId in hiddenVaultIds
}
