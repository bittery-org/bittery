package com.bittery.mobile.keystore

import android.app.Activity
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

/**
 * The `secret` tier, backed by the Android Keystore.
 *
 * One AES-256-GCM key lives in the `AndroidKeyStore` provider and never leaves it. Values are
 * encrypted with that key and the *ciphertext* is what lands on disk, in an ordinary
 * `SharedPreferences` file. Reading costs no prompt and no user interaction — see
 * [getOrCreateKey] for why that is the entire point.
 *
 * Not `androidx.security:security-crypto` / `EncryptedSharedPreferences`: Google deprecated it,
 * and the file this class writes holds `vault_keys` and `device_key`.
 */
@TauriPlugin
class KeystorePlugin(private val activity: Activity) : Plugin(activity) {

	@InvokeArg
	class SetArgs {
		lateinit var key: String
		lateinit var value: String
	}

	@InvokeArg
	class KeyArgs {
		lateinit var key: String
	}

	private val appContext: Context get() = activity.applicationContext

	private fun prefs(): SharedPreferences =
		appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

	// ------------------------------------------------------------------
	// Commands
	// ------------------------------------------------------------------

	/**
	 * The probe the storage adapter calls once, in `initialize()`.
	 *
	 * It does a real encrypt/decrypt round trip rather than merely checking that a key exists,
	 * because "the alias is present" and "this device can actually use it" are different facts
	 * and only the second one is worth routing `vault_keys` through. Any failure answers
	 * `available: false`, which sends the adapter back to `secrets.json` — the M1 behaviour.
	 */
	@Command
	fun secretAvailable(invoke: Invoke) {
		val result = JSObject()
		try {
			val key = getOrCreateKey()
			val probe = "bittery-keystore-probe"
			val roundTripped = open(key, seal(key, probe))
			if (roundTripped != probe) {
				throw IllegalStateException("round-trip mismatch")
			}
			result.put("available", true)
			result.put("backing", describeBacking(key))
		} catch (cause: Throwable) {
			// Never rethrow: an unusable Keystore must degrade to the fallback, not to a
			// broken app.
			result.put("available", false)
			result.put("backing", "Android Keystore unavailable — ${describe(cause)}")
		}
		invoke.resolve(result)
	}

	/** Overwrites. A failed write of key material is fatal and is reported as an error. */
	@Command
	fun secretSet(invoke: Invoke) {
		val args = invoke.parseArgs(SetArgs::class.java)
		try {
			val stored = seal(getOrCreateKey(), args.value)
			// `commit`, not `apply`: `secretSet` resolving must mean the bytes are on disk,
			// the same durability bar the plugin-store path meets with `save()`.
			if (!prefs().edit().putString(args.key, stored).commit()) {
				throw IllegalStateException("SharedPreferences.commit returned false")
			}
			invoke.resolve()
		} catch (cause: Throwable) {
			invoke.reject("secretSet failed: ${describe(cause)}")
		}
	}

	/**
	 * Missing key -> `null`, never a throw.
	 *
	 * An undecryptable value is also `null`, and the stale ciphertext is removed. See
	 * [getOrCreateKey] on why that case is real and what it costs.
	 */
	@Command
	fun secretGet(invoke: Invoke) {
		val args = invoke.parseArgs(KeyArgs::class.java)
		val result = JSObject()
		result.put("value", JSONObject.NULL)
		try {
			val stored = prefs().getString(args.key, null)
			if (stored != null) {
				val plaintext = open(getOrCreateKey(), stored)
				result.put("value", plaintext)
			}
		} catch (cause: Throwable) {
			// The ciphertext cannot be read back, now or ever: the key that made it is gone.
			// Clearing it means the next `secretSet` starts clean instead of the app reading
			// the same corpse on every launch.
			prefs().edit().remove(args.key).apply()
			result.put("value", JSONObject.NULL)
		}
		invoke.resolve(result)
	}

	/** Deleting an absent key is a no-op, never a throw. */
	@Command
	fun secretDelete(invoke: Invoke) {
		val args = invoke.parseArgs(KeyArgs::class.java)
		try {
			prefs().edit().remove(args.key).commit()
		} catch (_: Throwable) {
			// A throw here would abort `AccountStore.clearSession` and leave the vault
			// unlocked with `vault_keys` still on disk.
		}
		invoke.resolve()
	}

	// ------------------------------------------------------------------
	// The key
	// ------------------------------------------------------------------

	/**
	 * The one AES-256 key, created on first use.
	 *
	 * **`setUserAuthenticationRequired` is deliberately NOT set, and must never be added.**
	 * That flag is what makes every read raise a biometric/lock-screen prompt. `jwt_token` is
	 * read on every API request, so a prompt per read is a prompt per HTTP call and the app
	 * becomes unusable. That is precisely why `@choochmeque/tauri-plugin-biometry-api`'s secure
	 * data was rejected (`docs/mobile-migration-decisions.md` D4). Prompting belongs in
	 * `BiometricPort`, where the user asked for it, not here.
	 *
	 * **StrongBox is deliberately NOT requested.** `setIsStrongBoxBacked(true)` throws
	 * `StrongBoxUnavailableException` at key generation on the many devices without a secure
	 * element, which would lock those users out of their own vault entirely. The TEE is what
	 * the platform gives us and it is what we take.
	 *
	 * **Key loss is data loss, and it is handled here.** If the alias has vanished or been
	 * invalidated — a lock-screen change, a restored backup, a factory-reset keystore — every
	 * ciphertext already on disk is permanently undecryptable. Rather than wedge, this
	 * regenerates the key and clears the stale ciphertexts: the app then sees an empty secret
	 * tier and falls back to a full sign-in, which is the recoverable outcome.
	 */
	private fun getOrCreateKey(): SecretKey {
		val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
		val existing = try {
			keyStore.getKey(KEY_ALIAS, null) as? SecretKey
		} catch (_: Throwable) {
			null
		}
		if (existing != null) {
			return existing
		}

		if (keyStore.containsAlias(KEY_ALIAS)) {
			keyStore.deleteEntry(KEY_ALIAS)
		}
		// Everything under the old key is unreadable; drop it in one go.
		prefs().edit().clear().commit()

		val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
		generator.init(
			KeyGenParameterSpec.Builder(
				KEY_ALIAS,
				KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
			)
				.setKeySize(256)
				.setBlockModes(KeyProperties.BLOCK_MODE_GCM)
				.setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
				// The platform supplies a fresh IV per encryption. Supplying our own would be
				// the classic GCM nonce-reuse foot-gun; this makes it impossible.
				.setRandomizedEncryptionRequired(true)
				.build()
		)
		return generator.generateKey()
	}

	/**
	 * What `backing` reports, and it reports only what was observed.
	 *
	 * API 31+ has `KeyInfo.getSecurityLevel()`, which distinguishes software, TEE and StrongBox.
	 * Below that the only signal is the deprecated `isInsideSecureHardware()`, a boolean. If
	 * neither can be read, the string says the backing is unknown rather than claiming hardware.
	 */
	private fun describeBacking(key: SecretKey): String {
		val hardware = try {
			val factory = SecretKeyFactory.getInstance(key.algorithm, ANDROID_KEYSTORE)
			val info = factory.getKeySpec(key, KeyInfo::class.java) as KeyInfo
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
				when (info.securityLevel) {
					KeyProperties.SECURITY_LEVEL_STRONGBOX ->
						"hardware-backed (StrongBox, KeyInfo.securityLevel)"
					KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT ->
						"hardware-backed (TEE, KeyInfo.securityLevel)"
					KeyProperties.SECURITY_LEVEL_SOFTWARE ->
						"NOT hardware-backed (software, KeyInfo.securityLevel)"
					else ->
						"hardware backing unknown (KeyInfo.securityLevel=${info.securityLevel})"
				}
			} else {
				@Suppress("DEPRECATION")
				if (info.isInsideSecureHardware) {
					"hardware-backed (KeyInfo.isInsideSecureHardware)"
				} else {
					"NOT hardware-backed (KeyInfo.isInsideSecureHardware=false)"
				}
			}
		} catch (cause: Throwable) {
			"hardware backing unknown (${describe(cause)})"
		}
		return "Android Keystore AES-256-GCM, alias $KEY_ALIAS, no user-auth required — $hardware"
	}

	// ------------------------------------------------------------------
	// The envelope
	// ------------------------------------------------------------------

	/**
	 * `v1:<base64 IV>:<base64 ciphertext+tag>`, base64 NO_WRAP.
	 *
	 * Two fixed-alphabet fields separated by a character base64 never emits, so the split is
	 * unambiguous; the `v1` tag makes a future format change a detected mismatch rather than a
	 * decrypt failure that looks like key loss.
	 */
	private fun seal(key: SecretKey, plaintext: String): String {
		val cipher = Cipher.getInstance(TRANSFORMATION)
		cipher.init(Cipher.ENCRYPT_MODE, key)
		val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
		val iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
		return "$FORMAT_VERSION:$iv:${Base64.encodeToString(ciphertext, Base64.NO_WRAP)}"
	}

	private fun open(key: SecretKey, stored: String): String {
		val parts = stored.split(":")
		if (parts.size != 3 || parts[0] != FORMAT_VERSION) {
			throw IllegalArgumentException("unrecognised stored format")
		}
		val iv = Base64.decode(parts[1], Base64.NO_WRAP)
		val ciphertext = Base64.decode(parts[2], Base64.NO_WRAP)
		val cipher = Cipher.getInstance(TRANSFORMATION)
		cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
		return String(cipher.doFinal(ciphertext), Charsets.UTF_8)
	}

	private fun describe(cause: Throwable): String =
		"${cause.javaClass.simpleName}: ${cause.message ?: "(no message)"}"

	companion object {
		private const val ANDROID_KEYSTORE = "AndroidKeyStore"
		private const val KEY_ALIAS = "bittery_secret_v1"
		private const val PREFS_NAME = "bittery_keystore_secrets"
		private const val TRANSFORMATION = "AES/GCM/NoPadding"
		private const val GCM_TAG_BITS = 128
		private const val FORMAT_VERSION = "v1"
	}
}
