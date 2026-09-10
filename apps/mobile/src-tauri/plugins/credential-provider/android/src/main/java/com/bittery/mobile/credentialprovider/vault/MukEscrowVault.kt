package com.bittery.mobile.credentialprovider.vault

import com.bittery.mobile.credentialprovider.crypto.MukEscrowManager
import javax.crypto.Cipher

/**
 * The escrow, in the Android Keystore and SharedPreferences.
 *
 * A thin adapter over [MukEscrowManager], so the vault can be handed a fake
 * escrow in a test without a Keystore.
 */
internal class MukEscrowVault(private val manager: MukEscrowManager) : EscrowVault {

    override fun hasValidEscrow(): Boolean = manager.hasValidEscrow()

    override fun hasValidEscrowForEmail(email: String): Boolean =
        manager.hasValidEscrowForEmail(email)

    override fun remainingMs(): Long = manager.getEscrowRemainingTime()

    override fun accountId(): String? = manager.getEscrowAccountId()

    override fun serverUserId(): String? = manager.getEscrowUserId()

    override fun canUseBiometricUnlock(): Boolean = manager.canUseBiometricUnlock()

    override fun isMasterPasswordReentryRequired(): Boolean =
        manager.isMasterPasswordReentryRequired()

    override fun recordMasterPasswordEntry() = manager.updateLastMasterPasswordEntry()

    override fun lastMasterPasswordEntryMs(): Long = manager.getLastMasterPasswordEntry()

    override fun clear() = manager.clearEscrow()

    override fun wrap(
        muk: ByteArray,
        email: String,
        accountId: String,
        serverUserId: String,
        timeoutMs: Long,
    ) = manager.escrowMukUnattended(
        muk = muk,
        email = email,
        accountId = accountId,
        userId = serverUserId,
        timeoutMs = timeoutMs,
    )

    override fun decryptCipher(): Cipher = manager.getDecryptCipher()

    override fun unwrap(cipher: Cipher): ByteArray = manager.retrieveEscrowedMuk(cipher)
}
