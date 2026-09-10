package com.bittery.mobile.keystore

import android.app.Activity
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.AEADBadTagException
import javax.crypto.BadPaddingException
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
 *
 * **A stored value is deleted only when it is provably unreadable forever.** "I could not read
 * this" and "this can never be read" are different facts and the whole file turns on the
 * difference — see [isPermanentlyUnreadable]. A transient Keystore failure (keystore2 restarted,
 * `BackendBusyException`, a binder hiccup) answers `null` and touches no disk, because the next
 * attempt can succeed and a wrong deletion here costs the user a full sign-in with master
 * password *and* Secret Key.
 *
 * **Threading.** Every `@Command` here runs on the Android main thread, serialised: Tauri's
 * `PluginHandle.invoke` calls the method reflectively and synchronously with no executor, and the
 * Rust side dispatches through `run_on_android_context` onto wry's single main-thread pipe. That
 * is the only reason [getOrCreateKey] needs no lock — two calls can never interleave, so two
 * threads can never generate over the same alias and clobber each other's ciphertexts. `Cipher`
 * instances are created per call and never shared, so those are safe either way. If anyone ever
 * moves a command onto a background executor, this class needs a monitor around
 * [getOrCreateKey] first.
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
	 *
	 * It runs on every launch, before the `secrets.json` drain, so it must not be able to destroy
	 * anything: it writes no entry of its own, and the only clear in this class now happens after
	 * a fresh key exists and only when the old one was provably gone. A transient Keystore error
	 * during the probe costs this launch a fallback to `secrets.json` — a sign-out at worst — and
	 * leaves every ciphertext where it was for the next launch to read.
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
	 * Missing key -> `null`, never a throw. Unreadable key -> `null`, also never a throw.
	 *
	 * The value is removed only when the failure proves it can never be decrypted again —
	 * [isPermanentlyUnreadable]. Everything else answers `null` and leaves the bytes alone: a
	 * `BackendBusyException` is documented by Android as "try again with a back-off", a
	 * keystore2 restart resolves itself, and deleting on either turns a retryable read into
	 * permanent key loss.
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
			if (isPermanentlyUnreadable(cause)) {
				// The key that made this ciphertext is gone, or the ciphertext is not an
				// envelope at all. Clearing it means the next `secretSet` starts clean instead
				// of the app reading the same corpse on every launch. `commit`, not `apply`,
				// for the durability reason given on `secretSet`.
				commitOrWarn(prefs().edit().remove(args.key), "remove ${args.key}")
			}
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
	 * **Key loss is data loss, and it is handled here — but only when the loss is proven.** If the
	 * alias has genuinely vanished — a lock-screen change, a restored backup, a factory-reset
	 * keystore — every ciphertext already on disk is permanently undecryptable. Rather than wedge,
	 * this regenerates the key and clears the stale ciphertexts: the app then sees an empty secret
	 * tier and falls back to a full sign-in, which is the recoverable outcome.
	 *
	 * Two rules keep that from firing on a device whose Keystore is merely *unwell*:
	 *
	 *  1. **A read error propagates.** `AndroidKeyStoreSpi.engineGetKey` returns `null` for
	 *     exactly one condition, `KEY_NOT_FOUND`; every other keystore2 failure — service
	 *     restart, `SYSTEM_ERROR`, `VALUE_CORRUPTED`, a binder hiccup — is rethrown as
	 *     `UnrecoverableKeyException`. Swallowing that would read "the key is gone" off a
	 *     perfectly good key. `containsAlias` is no help either: it *swallows* the same
	 *     exception and answers `false`. So `null` from `getKey`, and only that, means absent.
	 *     Callers cope: `secretGet` turns a throw into `null`, `secretDelete` swallows, and the
	 *     probe answers `available: false` and sends the adapter to `secrets.json` for one
	 *     launch.
	 *  2. **Generate first, clear second.** If `generateKey()` throws — `KeyStoreConnectException`,
	 *     `ProviderException` — the ciphertexts are still there for the next attempt. Clearing
	 *     first would destroy them with no key to show for it.
	 */
	private fun getOrCreateKey(): SecretKey {
		val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
		// Deliberately uncaught: see rule 1 above.
		val existing = keyStore.getKey(KEY_ALIAS, null) as? SecretKey
		if (existing != null) {
			return existing
		}

		// Provably `KEY_NOT_FOUND` (or an entry that is not a secret key, which this alias never
		// holds and which generation overwrites anyway). Only now is a rotation warranted.
		val fresh = generateKey()
		// Everything under the old key is unreadable; drop it in one go. If the clear fails the
		// stale entries stay, and `secretGet` drops each one as it fails to decrypt — the same
		// end state, one read later.
		commitOrWarn(prefs().edit().clear(), "clear after key rotation")
		return fresh
	}

	private fun generateKey(): SecretKey {
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
	 * decrypt failure that looks like key loss — and, because the two are told apart in
	 * [isPermanentlyUnreadable], a `v2` value survives a rollback onto this build untouched.
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
		if (parts.size != 3) {
			throw CorruptEnvelopeException("expected 3 fields, got ${parts.size}")
		}
		if (parts[0] != FORMAT_VERSION) {
			// Not damage: a build that knows a later format wrote this, and this build was
			// rolled back onto it. Deleting would destroy a value the newer build reads fine.
			throw UnknownEnvelopeVersionException(parts[0])
		}
		val iv = decodeField(parts[1], "IV")
		val ciphertext = decodeField(parts[2], "ciphertext")
		val cipher = Cipher.getInstance(TRANSFORMATION)
		cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
		return String(cipher.doFinal(ciphertext), Charsets.UTF_8)
	}

	private fun decodeField(field: String, what: String): ByteArray =
		try {
			Base64.decode(field, Base64.NO_WRAP)
		} catch (cause: IllegalArgumentException) {
			throw CorruptEnvelopeException("$what is not base64: ${describe(cause)}")
		}

	/** A `v1` envelope this build can never parse. The bytes are damaged, not merely unread. */
	private class CorruptEnvelopeException(message: String) : Exception(message)

	/** A well-formed envelope from another format version. Ours to skip, never ours to delete. */
	private class UnknownEnvelopeVersionException(version: String) :
		Exception("stored format version '$version' is not $FORMAT_VERSION")

	// ------------------------------------------------------------------
	// Permanent vs transient
	// ------------------------------------------------------------------

	/**
	 * Whether a failed read proves the stored value is unreadable **forever**.
	 *
	 * Only these two families qualify:
	 *
	 *  - a GCM tag mismatch (`AEADBadTagException`, and its parent `BadPaddingException`), which
	 *    means the ciphertext was made under a key that no longer exists — no retry recovers it;
	 *  - a [CorruptEnvelopeException], where the stored string is not a decodable `v1` envelope.
	 *
	 * Everything else is transient until proven otherwise, and the caller must leave the disk
	 * alone: `BackendBusyException` is documented as retryable ("try again with a back-off
	 * period"), `KeyStoreConnectException` and other `ProviderException`s mean keystore2 was
	 * momentarily unreachable, and [UnknownEnvelopeVersionException] means the value belongs to a
	 * different build of this plugin. Guessing wrong in this direction costs a launch; guessing
	 * wrong in the other costs the user their vault keys.
	 */
	private fun isPermanentlyUnreadable(cause: Throwable): Boolean = when (cause) {
		is AEADBadTagException, is BadPaddingException, is CorruptEnvelopeException -> true
		else -> false
	}

	/**
	 * `commit`, and say so when it fails.
	 *
	 * A dropped write here is never fatal — the callers are self-healing — but a silent one is
	 * how a stale ciphertext survives unexplained, so it goes in the log.
	 */
	private fun commitOrWarn(editor: SharedPreferences.Editor, what: String): Boolean {
		val committed = editor.commit()
		if (!committed) {
			Log.w(LOG_TAG, "SharedPreferences.commit returned false: $what")
		}
		return committed
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
		private const val LOG_TAG = "BitteryKeystore"
	}
}
