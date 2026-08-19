package com.bittery.mobile.credentialprovider.storage

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * The travel-mode policy in force for one account.
 *
 * Stored beside the rows it governs, because the two must not be separable. A
 * process restart loses the master unlock key but keeps this table, and a
 * biometric unlock can put a key back without the app syncing first — the vault
 * needs the policy at that moment, not at the next sync.
 *
 * Storing the hidden vault ids costs nothing the device did not already pay: the
 * app persists the same list in plaintext under `travel_mode_cache`, a
 * device-bound value on every platform (`packages/storage/src/tiers.ts`). What is
 * *not* here is the hidden vaults' material — that is erased when the policy
 * arrives.
 *
 * A missing row is not "travel mode off". It means no policy was verified, and
 * the vault answers nothing for that account.
 */
@Entity(tableName = "travel_mode_policy")
data class TravelModePolicyEntity(
    /** The server's user id, which is what the replica rows are keyed by. */
    @PrimaryKey
    val userId: String,

    val enabled: Boolean,

    /** The hidden vault ids, newline-separated. Room stores no collections. */
    val hiddenVaultIds: String,

    /** `TravelModeResponse.updatedAt` in milliseconds: the policy's version. */
    val updatedAt: Long?,
)
