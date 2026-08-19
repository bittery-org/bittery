package com.bittery.mobile.credentialprovider.vault

import androidx.fragment.app.FragmentActivity
import com.bittery.mobile.credentialprovider.crypto.MukEscrowManager

/**
 * How long an escrowed key stays usable when the caller names no timeout.
 *
 * It outlives auto-lock on purpose: auto-lock drops the in-memory key, and the
 * keyboard bar still has to unwrap after that.
 */
internal const val DEFAULT_BIOMETRIC_UNLOCK_TIMEOUT_MS = MukEscrowManager.DEFAULT_ESCROW_TIMEOUT_MS

/**
 * The one way into Bittery's native vault.
 *
 * Everything the credential provider needs is behind this: the live unlock state,
 * the biometric escrow, the encrypted replica, domain matching, vault-key lookup
 * and decryption. A caller asks a question in its own words — "what can I offer on
 * this origin?", "reveal this item's password" — and the vault decides which keys,
 * which rows and which cipher that takes.
 *
 * Callers keep the Android framework. Nothing here returns a `RemoteViews`, a
 * `Dataset`, a `FillResponse`, a `PendingIntent` or a credential-framework
 * response; those are built in the service or activity that owns the request, from
 * the plain records below.
 *
 * **Live only, for every read.** [isUnlocked], [borrowLiveMasterUnlockKey] and
 * every lookup answer from the in-memory keys and nothing else. A lock, an
 * auto-lock or a process restart really does lose the key, and no read can bring
 * one back. [unlockWithBiometric] is the single exception, and it shows a prompt
 * the user sees. `PROCESS-MODEL.md` explains why one process makes this work.
 *
 * **Travel mode is enforced here, not upstream.** The app also filters a hidden
 * vault out before it syncs, but this vault does not rely on that. Every snapshot
 * carries the account's policy ([CredentialReplicaSnapshot.travelMode]); a hidden
 * vault's keys and items are erased when the policy arrives, and every lookup below
 * is filtered again on the way out. [TravelModeReplicaStore] is where the second
 * half is written, once. An account whose policy nobody verified is served nothing.
 */
internal interface NativeCredentialVault {

    // ------------------------------------------------------------------
    // Live unlock state
    // ------------------------------------------------------------------

    /** Whether this account has a live key. A read, with no side effect. */
    fun isUnlocked(accountId: String): Boolean

    /** Every account with a live key, oldest unlock first. */
    fun unlockedAccountIds(): List<String>

    /**
     * A copy of the live key, or `null` when this process holds none.
     *
     * Never reads the escrow and never touches disk. Callers zeroize what they get.
     */
    fun borrowLiveMasterUnlockKey(accountId: String): ByteArray?

    /**
     * Take a key that an explicit unlock produced — the app after a password
     * unlock, this vault after a biometric one.
     *
     * The bytes are copied, so the caller still owns and should blank its array.
     * A null [autoLockTimeoutMs] keeps whatever timeout the account already had.
     *
     * [serverUserId] rides along because the replica keys its rows by the server
     * id while everything above keys by account id. A lock forgets both at once.
     */
    fun acceptUnlockedKey(
        accountId: String,
        serverUserId: String,
        muk: ByteArray,
        autoLockTimeoutMs: Long? = null,
    )

    /** Set the auto-lock timeout and re-arm any live key from now. */
    fun setAutoLockTimeout(accountId: String, timeoutMs: Long)

    /** Lock one account, or every account when [accountId] is `null`. */
    fun lock(accountId: String?)

    // ------------------------------------------------------------------
    // Biometric unlock — the one path that reads the escrow
    // ------------------------------------------------------------------

    /** What the escrow can do right now, so a caller can pick its route. */
    fun biometricUnlockState(): BiometricUnlockState

    /** Whether the escrowed key belongs to this email. */
    fun hasBiometricUnlockFor(email: String): Boolean

    /**
     * Wrap the account's live key so a later unlock can unwrap it with biometrics.
     *
     * Uses the public half of the wrap key, so it shows no prompt. Throws
     * `IllegalArgumentException` when the account id is not a real one.
     */
    fun enrolBiometricUnlock(
        accountId: String,
        serverUserId: String,
        email: String,
        timeoutMs: Long,
    ): EnrolResult

    /**
     * Prompt for biometrics and restore the escrowed key into the live state.
     *
     * The account comes from the escrow record; it is the only account the record
     * can unlock. [subtitle] is the one line that differs between the app's own
     * prompt and the autofill one.
     */
    suspend fun unlockWithBiometric(activity: FragmentActivity, subtitle: String): UnlockResult

    /** Drop the escrowed key. The live keys are untouched. */
    fun forgetBiometricUnlock()

    /**
     * Drop the escrowed key unless it belongs to another account. `false` means the
     * slot was left alone because someone else holds it.
     *
     * The escrow is one slot, so a sign-out has to name its account: clearing on
     * every sign-out would cost an unrelated account the biometric unlock it
     * enrolled. A record that names no account is dropped by any caller — nothing
     * can attribute it, and it cannot unlock anything either.
     */
    fun forgetBiometricUnlockFor(accountId: String): Boolean

    /** Restart the 30-day master-password clock after a password unlock. */
    fun recordMasterPasswordEntry()

    // ------------------------------------------------------------------
    // The local replica
    // ------------------------------------------------------------------

    /** Replace this account's replica with what the server just sent. */
    suspend fun replaceReplica(snapshot: CredentialReplicaSnapshot): ReplicaUpdateResult

    /** Vault writes made on the device that the server has not accepted yet. */
    suspend fun queuedVaultWrites(serverUserId: String?): List<PendingPasskeyMutation>

    /** The server accepted these writes. Drop them. */
    suspend fun forgetQueuedVaultWrites(ids: List<String>)

    /** The server refused these writes. Count the attempt and keep the reason. */
    suspend fun recordQueuedVaultWriteFailure(ids: List<String>, error: String)

    // ------------------------------------------------------------------
    // What can be offered here
    // ------------------------------------------------------------------

    /**
     * Filled-in credentials for an origin, across every unlocked account.
     *
     * Decrypts, so this is the autofill path that puts a password into a field.
     * At most [limit] come back; an item that will not decrypt is skipped.
     */
    suspend fun credentialsForOrigin(origin: String, limit: Int): List<NativeCredential>

    /**
     * Password entries to *offer* for an origin — labels only, no secrets.
     *
     * The Credential Manager picker shows these before the user chooses, so
     * nothing is decrypted. An origin that names no web host offers nothing.
     */
    suspend fun passwordSuggestionsForOrigin(origin: String): List<PasswordSuggestion>

    /** Passkey entries to offer for a relying party. Decrypts to read the passkeys. */
    suspend fun passkeySuggestionsFor(
        rpId: String,
        allowedCredentialIds: Set<String>,
    ): List<PasskeySuggestion>

    /**
     * The username and password of one item, after the user picked it.
     *
     * Records the use. A locked account answers [PasswordReveal.Locked] rather
     * than reaching for the escrow — the caller decides whether to prompt.
     */
    suspend fun revealPassword(itemId: String): PasswordReveal

    // ------------------------------------------------------------------
    // Passkeys
    // ------------------------------------------------------------------

    /** Sign an assertion with a stored passkey and record the new sign count. */
    suspend fun assertPasskey(request: PasskeyAssertionRequest): PasskeyAssertionResult

    /** Which item a new passkey should be saved to, or the question to ask. */
    suspend fun passkeySaveTarget(rpId: String, userName: String): PasskeySaveTargetChoice

    /** Generate a passkey, store it and queue the write for the server. */
    suspend fun savePasskey(request: PasskeySaveRequest): PasskeySaveResult
}

// ----------------------------------------------------------------------
// What the vault answers with
// ----------------------------------------------------------------------

/**
 * The escrow's readiness, as three separate facts.
 *
 * They are separate because callers branch on different ones: the app asks
 * whether a record exists at all, autofill asks whether it may be used now.
 */
internal data class BiometricUnlockState(
    val hasEscrow: Boolean,
    /** Escrow is valid *and* the 30-day master-password clock has not run out. */
    val canUnlock: Boolean,
    val masterPasswordRequired: Boolean,
    val remainingMs: Long,
    val lastMasterPasswordEntryMs: Long,
)

internal sealed interface EnrolResult {
    data object Enrolled : EnrolResult

    /** No live key to wrap. Escrow follows an unlock; it cannot start one. */
    data object VaultLocked : EnrolResult

    data class Failed(val message: String, val cause: Exception) : EnrolResult
}

internal sealed interface UnlockResult {
    data class Unlocked(val accountId: String, val serverUserId: String) : UnlockResult

    /** Nothing to unwrap. The user has to unlock in the app. */
    data object NoEscrow : UnlockResult

    /** The record predates the account-id rekey. Re-enrolment needs the password. */
    data object NeedsReenrolment : UnlockResult

    /** The user cancelled, or the sensor refused. */
    data class Rejected(val message: String) : UnlockResult

    /** Authentication passed and the unwrap still failed. */
    data class Failed(val message: String, val cause: Exception?) : UnlockResult

    /** No activity could host the prompt. Asking again elsewhere may work. */
    data class PromptUnavailable(val message: String) : UnlockResult

    /** The prompt itself would not start. */
    data class PromptFailed(val message: String) : UnlockResult
}

/** A credential ready to be typed into a field. Never logged. */
internal class NativeCredential(
    val itemId: String,
    val accountId: String,
    val label: String,
    val username: String,
    val password: String,
)

/** A password entry to show, with nothing secret in it. */
internal data class PasswordSuggestion(
    val itemId: String,
    val username: String,
    val displayName: String,
    val lastUsedAtMs: Long,
)

/** A passkey entry to show, with nothing secret in it. */
internal data class PasskeySuggestion(
    val itemId: String,
    val credentialId: String,
    val username: String,
    val displayName: String,
    val lastUsedAtMs: Long,
)

internal sealed interface PasswordReveal {
    data class Revealed(val username: String, val password: String) : PasswordReveal

    data object ItemNotFound : PasswordReveal

    /**
     * The item's account holds no live key.
     *
     * [canUnlockWithBiometric] means the escrowed key belongs to *this* item's
     * account, so a prompt would help. Otherwise only the app can unlock it.
     */
    data class Locked(val canUnlockWithBiometric: Boolean) : PasswordReveal

    data class Failed(val reason: String) : PasswordReveal
}

internal data class PasskeyAssertionRequest(
    val itemId: String,
    val credentialId: String,
    val rpId: String,
    val clientDataHashBase64: String,
)

internal sealed interface PasskeyAssertionResult {
    class Signed(
        val credentialIdBytes: ByteArray,
        val authenticatorData: ByteArray,
        val signature: ByteArray,
        val userHandle: ByteArray,
    ) : PasskeyAssertionResult

    data object ItemNotFound : PasskeyAssertionResult

    data object Locked : PasskeyAssertionResult

    data class Failed(val reason: String) : PasskeyAssertionResult
}

/** Where a new passkey goes. */
internal sealed interface PasskeySaveTarget {
    data class ExistingItem(val itemId: String) : PasskeySaveTarget

    data object NewItem : PasskeySaveTarget
}

internal sealed interface PasskeySaveTargetChoice {
    /** The vault picked. Nothing to ask. */
    data class Resolved(val target: PasskeySaveTarget) : PasskeySaveTargetChoice

    /** Several items could hold it. Only the user can choose. */
    data class Ambiguous(val candidates: List<PasskeySaveCandidate>) : PasskeySaveTargetChoice

    /** No account is unlocked, so there is nowhere to write. */
    data object VaultLocked : PasskeySaveTargetChoice

    /** An item matches, but its account is locked. Unlocking it is the fix. */
    data object LockedAccountOwnsMatch : PasskeySaveTargetChoice
}

internal data class PasskeySaveCandidate(
    val itemId: String,
    val label: String,
    val username: String?,
)

internal data class PasskeySaveRequest(
    val target: PasskeySaveTarget,
    val rpId: String,
    val rpName: String,
    val userHandle: String,
    val userName: String,
    val userDisplayName: String,
)

internal sealed interface PasskeySaveResult {
    class Saved(
        val itemId: String,
        val credentialIdBytes: ByteArray,
        val publicKeyCose: ByteArray,
        val publicKeySpki: ByteArray,
        val attestationObject: ByteArray,
        val authenticatorData: ByteArray,
    ) : PasskeySaveResult

    data class Failed(val reason: String) : PasskeySaveResult
}

internal sealed interface ReplicaUpdateResult {
    data class Applied(
        val vaultKeys: Int,
        val items: Int,
        val domains: Int,
        val deletedVaultKeys: Int,
        val deletedItems: Int,
    ) : ReplicaUpdateResult

    /** The payload was not a complete snapshot. Nothing was written. */
    data class Rejected(val reason: String) : ReplicaUpdateResult
}
