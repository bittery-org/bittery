package com.bittery.mobile.credentialprovider.vault

import javax.crypto.Cipher

/**
 * The persistent, biometric-gated escrow of one master unlock key.
 *
 * Separate from the live state on purpose. The live key dies with a lock, an
 * auto-lock or the process; the escrow outlives all three, because the keyboard
 * bar still has to unwrap after an auto-lock. Only [NativeCredentialVault]'s
 * explicit biometric unlock reads it — no status check and no borrow ever does.
 */
internal interface EscrowVault {

    /** A usable, unexpired record that names both identities. */
    fun hasValidEscrow(): Boolean

    fun hasValidEscrowForEmail(email: String): Boolean

    /** Milliseconds until the record expires, or 0 when there is none. */
    fun remainingMs(): Long

    /** The account the record belongs to. Null on a record written before the rekey. */
    fun accountId(): String?

    fun serverUserId(): String?

    /** Escrow is valid *and* the 30-day master-password clock has not run out. */
    fun canUseBiometricUnlock(): Boolean

    fun isMasterPasswordReentryRequired(): Boolean

    fun recordMasterPasswordEntry()

    fun lastMasterPasswordEntryMs(): Long

    fun clear()

    /** Wrap a key with the public half. No prompt: the unwrap still needs one. */
    fun wrap(muk: ByteArray, email: String, accountId: String, serverUserId: String, timeoutMs: Long)

    /** The cipher a biometric prompt must authenticate before [unwrap] works. */
    fun decryptCipher(): Cipher

    fun unwrap(cipher: Cipher): ByteArray
}
