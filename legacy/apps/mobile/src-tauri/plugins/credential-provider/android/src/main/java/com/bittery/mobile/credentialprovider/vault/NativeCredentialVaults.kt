package com.bittery.mobile.credentialprovider.vault

import android.content.Context
import android.os.SystemClock
import com.bittery.mobile.credentialprovider.crypto.MukEscrowManager
import com.bittery.mobile.credentialprovider.storage.CredentialDatabase

/**
 * The one vault this process has.
 *
 * CRITICAL: the live keys live here and nowhere else, so this depends on the
 * whole credential provider running in the SAME PROCESS as the app. Do not add
 * `android:process` to any service or activity in AndroidManifest.xml — a second
 * process gets a second, empty vault. `PROCESS-MODEL.md` has the details.
 *
 * Auto-lock deadlines are measured on the monotonic clock. The wall clock can
 * jump backwards, and a deadline measured against it would hand a locked vault
 * more time.
 */
internal object NativeCredentialVaults {

    private val liveUnlocks = LiveUnlockStore(MonotonicClock { SystemClock.elapsedRealtime() })

    @Volatile
    private var instance: NativeCredentialVault? = null

    fun of(context: Context): NativeCredentialVault {
        return instance ?: synchronized(this) {
            instance ?: build(context.applicationContext).also { instance = it }
        }
    }

    private fun build(applicationContext: Context): NativeCredentialVault =
        AndroidNativeCredentialVault(
            liveUnlocks = liveUnlocks,
            escrow = MukEscrowVault(MukEscrowManager(applicationContext)),
            // Travel mode wraps the replica rather than sitting beside it, so every
            // read the vault makes is filtered and none can opt out.
            replica = TravelModeReplicaStore(
                RoomReplicaStore(CredentialDatabase.getInstance(applicationContext)),
            ),
            crypto = NativeVaultCrypto(),
            clock = { System.currentTimeMillis() },
            gate = AndroidBiometricGate(),
            logger = AndroidVaultLogger("NativeCredentialVault"),
        )
}
