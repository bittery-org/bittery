package com.bittery.mobile.credentialprovider.vault

import android.util.Log

/**
 * Where the vault's diagnostics go.
 *
 * A port, for one blunt reason: `android.util.Log` is a stub in JVM unit tests and
 * throws when it is called, so a single stray log line would put the vault's logic
 * out of reach of every test. [None] is what a test injects.
 *
 * Nothing logged here may carry key material, a base64 key, a ciphertext, a token
 * or a biometric artifact.
 */
internal interface VaultLogger {

    fun debug(message: String)

    fun warn(message: String, error: Throwable? = null)

    object None : VaultLogger {
        override fun debug(message: String) = Unit

        override fun warn(message: String, error: Throwable?) = Unit
    }
}

internal class AndroidVaultLogger(private val tag: String) : VaultLogger {

    override fun debug(message: String) {
        Log.d(tag, message)
    }

    override fun warn(message: String, error: Throwable?) {
        if (error == null) Log.w(tag, message) else Log.w(tag, message, error)
    }
}
