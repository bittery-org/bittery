package com.bittery.mobile.credentialprovider

import android.app.Activity
import android.app.Application
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.webkit.WebView
import androidx.annotation.RequiresApi
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.bittery.mobile.credentialprovider.crypto.MukEscrowManager
import com.bittery.mobile.credentialprovider.crypto.VaultDecryptor
import com.bittery.mobile.credentialprovider.domain.DomainMatch
import com.bittery.mobile.credentialprovider.state.VaultStateManager
import com.bittery.mobile.credentialprovider.storage.AuthDataEntity
import com.bittery.mobile.credentialprovider.storage.CredentialDatabase
import com.bittery.mobile.credentialprovider.storage.ItemDomainEntity
import com.bittery.mobile.credentialprovider.storage.ItemEntity
import com.bittery.mobile.credentialprovider.storage.VaultKeyEntity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

private const val TAG = "CredentialProviderPlugin"

private const val MIN_API = Build.VERSION_CODES.UPSIDE_DOWN_CAKE // 34

/** Must match `.service.BitteryCredentialProviderService` in the plugin manifest. */
private const val SERVICE_CLASS =
	"com.bittery.mobile.credentialprovider.service.BitteryCredentialProviderService"

/**
 * The Tauri bridge into the ported credential provider.
 *
 * This is a straight translation of the Expo module that used to live at
 * `apps/mobile/modules/credential-provider/android/.../CredentialProviderModule.kt`.
 * Every method body — the calls into [VaultStateManager], [MukEscrowManager], the Room
 * DAOs — is the same code, moved. Only the bridging layer changed: `Function`/
 * `AsyncFunction` became `@Command`, positional parameters became [InvokeArg] classes,
 * and `Promise` became [Invoke]. A behaviour change here is a security change, because
 * this class hands out the master unlock key.
 *
 * Everything the *system* calls — the two services and their activities — is reached by
 * intent and does not route through this class.
 *
 * **The resolve convention.** A Tauri command answers with a `JSObject`, never a bare
 * value, so every command here resolves exactly one key, `value`, holding what the Expo
 * method returned. The Rust layer unwraps it, so JavaScript still sees a `boolean`, a
 * `number`, a `string | null` or an array. One shape everywhere beats a per-command
 * guess about what "the" result key should be called.
 *
 * **Threading.** Tauri calls `@Command` methods reflectively and synchronously on the
 * Android main thread (`PluginHandle.invoke` -> `run_on_android_context` -> wry's
 * main-thread pipe). SharedPreferences and Keystore work is cheap enough to stay there,
 * which is where the Expo module's synchronous `Function`s ran too. **Room is not**: the
 * four commands that touch the database ([syncVaultData], [getPendingPasskeyMutations],
 * [markPendingPasskeyMutationsApplied], [markPendingPasskeyMutationsFailed]) launch on
 * [pluginScope], hop to `Dispatchers.IO` for the queries exactly as the Expo module did,
 * and call `invoke.resolve` from the coroutine when it finishes. Nothing blocks the main
 * thread waiting for them. `NativeCrypto`'s `runBlocking` is reached only through
 * [recoverDomainsFromEncryptedItem], which runs inside that IO context.
 */
@TauriPlugin
class CredentialProviderPlugin(private val activity: Activity) : Plugin(activity) {

	// ------------------------------------------------------------------
	// Arguments
	//
	// Jackson parses these (`Invoke.parseArgs`), with FAIL_ON_UNKNOWN_PROPERTIES off and
	// no Kotlin module registered. So every optional field is a *nullable, defaulted*
	// property with a boxed type: an absent field leaves the default, and an explicit
	// JSON `null` on a Kotlin primitive would trip FAIL_ON_NULL_FOR_PRIMITIVES.
	// ------------------------------------------------------------------

	@InvokeArg
	class UserIdArgs {
		var userId: String? = null
	}

	@InvokeArg
	class SetMasterUnlockKeyArgs {
		var mukBase64: String = ""
		var userId: String? = null
		var autoLockTimeoutMs: Double? = null
	}

	@InvokeArg
	class SetMukAutoLockTimeoutArgs {
		var timeoutMs: Double = 0.0
		var userId: String? = null
	}

	@InvokeArg
	class EscrowMukArgs {
		var email: String = ""
		var userId: String? = null
		var timeoutMs: Double? = null
	}

	@InvokeArg
	class EmailArgs {
		var email: String = ""
	}

	@InvokeArg
	class SyncVaultDataArgs {
		var dataJson: String = ""
	}

	@InvokeArg
	class IdsArgs {
		var ids: List<String> = emptyList()
	}

	@InvokeArg
	class IdsWithErrorArgs {
		var ids: List<String> = emptyList()
		var error: String = ""
	}

	// ------------------------------------------------------------------
	// Wiring
	// ------------------------------------------------------------------

	private val pluginScope = CoroutineScope(Dispatchers.Main + SupervisorJob())

	/**
	 * The live host activity, or `null` when there is none on screen.
	 *
	 * Tauri's `PluginManager` keeps the *first* activity forever — there is a `TODO` in
	 * its `onActivityCreate` saying so — and a `BiometricPrompt` attached to a destroyed
	 * or stopped `FragmentActivity` never shows and never calls back. So the plugin
	 * tracks the activity itself, the way the Expo module's `appContext.currentActivity`
	 * did: [activityTracker] is registered on the `Application` in [load] and writes here
	 * on every resume.
	 *
	 * `onRestart` alone could not do this. `Plugin.onRestart` arrives from
	 * `TauriActivity.onRestart()`, which only a *stopped and restarted* instance
	 * delivers — never a freshly created one. A recreated `MainActivity` (low memory,
	 * "Don't keep activities", a font-size change the manifest's `configChanges` does not
	 * cover) would have left this pointing at the dead instance forever.
	 *
	 * `@Volatile` because the tracker runs on the main thread while a `@Command` may read
	 * it from a coroutine.
	 */
	@Volatile
	private var boundActivity: Activity? = activity

	/**
	 * The activity class the plugin was constructed with — `MainActivity`.
	 *
	 * The tracker binds only to instances of it. The credential-provider service starts
	 * its own activities (`GetCredentialsActivity` and friends) in this same process, and
	 * they resume like any other; without this filter a system autofill screen would
	 * become the prompt host.
	 */
	private val hostActivityClass: Class<out Activity> = activity.javaClass

	private var trackerRegistered = false

	/**
	 * Follows the host activity across recreation. `onActivityResumed` is the hook —
	 * a resumed activity is by definition not destroyed, not finishing, and its
	 * `FragmentManager` has not saved state, which is exactly the precondition
	 * `BiometricPrompt` needs.
	 */
	private val activityTracker = object : Application.ActivityLifecycleCallbacks {
		override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}

		override fun onActivityStarted(activity: Activity) {}

		override fun onActivityResumed(activity: Activity) {
			if (activity.javaClass != hostActivityClass) {
				return
			}
			val changed = boundActivity !== activity
			boundActivity = activity
			Log.d(
				TAG,
				"onActivityResumed: rebind host activity ${activity.javaClass.simpleName}" +
					"@${System.identityHashCode(activity)} (changed=$changed)",
			)
		}

		override fun onActivityPaused(activity: Activity) {}

		override fun onActivityStopped(activity: Activity) {}

		override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}

		override fun onActivityDestroyed(activity: Activity) {
			if (boundActivity === activity) {
				boundActivity = null
				Log.d(TAG, "onActivityDestroyed: cleared the bound host activity")
			}
		}
	}

	/**
	 * Registers the tracker. `PluginManager` calls this once per plugin, either at
	 * registration or from `onWebViewCreated`, so [trackerRegistered] guards the double
	 * call — `registerActivityLifecycleCallbacks` keeps a plain list and would happily
	 * hold two copies.
	 *
	 * Nothing unregisters it. `Plugin` has no teardown hook: the only shutdown callback
	 * is `onDestroy(activity)`, which fires per *activity* destruction, and unregistering
	 * there would break the rebind this exists for. The tracker is bound to the
	 * `Application`, which outlives the plugin, and the plugin lives for the whole
	 * process — so there is nothing to leak into.
	 */
	override fun load(webView: WebView) {
		super.load(webView)
		if (trackerRegistered) {
			return
		}
		trackerRegistered = true
		activity.application.registerActivityLifecycleCallbacks(activityTracker)
		Log.d(TAG, "load: registered the activity lifecycle tracker")
	}

	/**
	 * Kept as a second source of truth. It cannot cover a recreated activity, but a
	 * restarted one costs nothing to record and does not depend on the tracker.
	 */
	override fun onRestart(activity: AppCompatActivity) {
		if (activity.javaClass == hostActivityClass) {
			boundActivity = activity
		}
	}

	override fun onDestroy(activity: AppCompatActivity) {
		if (boundActivity === activity) {
			boundActivity = null
		}
	}

	/**
	 * Application-scoped, matching the Expo module's `appContext.reactContext`. The
	 * escrow manager and the Room instance outlive any one activity, so an activity
	 * context here would leak it.
	 */
	private val context: Context
		get() = activity.applicationContext

	private val mukEscrowManager: MukEscrowManager by lazy { MukEscrowManager(context) }

	private val database: CredentialDatabase by lazy { CredentialDatabase.getInstance(context) }

	/**
	 * `BiometricPrompt` needs one, and it gets one: `MainActivity` extends
	 * `TauriActivity`, which extends wry's `WryActivity`, which extends
	 * `AppCompatActivity` — a `FragmentActivity`. The cast is still guarded, because a
	 * null here must reject with the Expo module's `NO_ACTIVITY` rather than crash.
	 */
	private val currentActivity: FragmentActivity?
		get() = boundActivity as? FragmentActivity

	/**
	 * Whether `activity` can actually host a `BiometricPrompt` right now.
	 *
	 * `BiometricPrompt.authenticate` opens with
	 * `if (mClientFragmentManager.isStateSaved()) { Log.e(…); return }` — it logs and
	 * returns, and **no callback ever fires**. An `Invoke` that neither resolves nor
	 * rejects leaves `run_mobile_plugin` blocked in `rx.recv()` and the JS `await`
	 * pending forever, which the UI cannot recover from. `isStateSaved()` is
	 * `mStateSaved || mStopped`, so a merely stopped activity is enough.
	 *
	 * Checking first turns a silent hang into a `NO_ACTIVITY` rejection the caller can
	 * see. [activityTracker] should make this unreachable; it is the second layer.
	 */
	private fun canHostPrompt(activity: FragmentActivity): Boolean =
		!activity.isDestroyed &&
			!activity.isFinishing &&
			!activity.supportFragmentManager.isStateSaved

	private fun ensureVaultStateManagerInitialized() {
		try {
			VaultStateManager.initialize(context)
		} catch (e: Exception) {
			Log.e(TAG, "Failed to initialize VaultStateManager", e)
		}
	}

	/** The one resolve shape: `{ "value": <result> }`. See the class comment. */
	private fun resolveValue(invoke: Invoke, value: Any?) {
		val result = JSObject()
		result.put("value", value ?: JSONObject.NULL)
		invoke.resolve(result)
	}

	private fun serviceComponent(): ComponentName =
		ComponentName(activity.applicationContext.packageName, SERVICE_CLASS)

	// ------------------------------------------------------------------
	// Vault state management (VaultStateManager)
	// ------------------------------------------------------------------

	/**
	 * Set the Master Unlock Key after successful login/unlock. This makes the MUK
	 * available to the `CredentialProviderService` for decryption.
	 */
	@Command
	fun setMasterUnlockKey(invoke: Invoke) {
		val args = invoke.parseArgs(SetMasterUnlockKeyArgs::class.java)
		try {
			ensureVaultStateManagerInitialized()
			val resolvedUserId = args.userId?.takeIf { it.isNotBlank() } ?: "default"
			val resolvedTimeoutMs = args.autoLockTimeoutMs?.toLong()
			Log.d(
				TAG,
				"setMasterUnlockKey: CALLED from the webview bridge (userId='$resolvedUserId', " +
					"mukBase64Length=${args.mukBase64.length}, timeoutMs=$resolvedTimeoutMs, " +
					"pid=${android.os.Process.myPid()})",
			)
			VaultStateManager.setMasterUnlockKeyFromBase64(
				args.mukBase64,
				resolvedUserId,
				resolvedTimeoutMs,
			)
			Log.d(TAG, "setMasterUnlockKey: MUK set successfully, verifying...")
			val verifyUnlocked = VaultStateManager.isUnlocked(resolvedUserId)
			Log.d(TAG, "setMasterUnlockKey: Verification isUnlocked($resolvedUserId)=$verifyUnlocked")
			emit("onVaultUnlocked")
			resolveValue(invoke, true)
		} catch (e: Exception) {
			Log.e(TAG, "setMasterUnlockKey: Failed to set MUK", e)
			resolveValue(invoke, false)
		}
	}

	/** Update the native MUK auto-lock timeout for a user, applied immediately. */
	@Command
	fun setMukAutoLockTimeout(invoke: Invoke) {
		val args = invoke.parseArgs(SetMukAutoLockTimeoutArgs::class.java)
		try {
			ensureVaultStateManagerInitialized()
			val resolvedUserId = args.userId?.takeIf { it.isNotBlank() } ?: "default"
			val resolvedTimeoutMs = args.timeoutMs.toLong()
			Log.d(TAG, "setMukAutoLockTimeout: userId='$resolvedUserId', timeoutMs=$resolvedTimeoutMs")
			VaultStateManager.setMukAutoLockTimeout(resolvedUserId, resolvedTimeoutMs)
			resolveValue(invoke, true)
		} catch (e: Exception) {
			Log.e(TAG, "setMukAutoLockTimeout: failed", e)
			resolveValue(invoke, false)
		}
	}

	/** Clear the Master Unlock Key (on logout or auto-lock). */
	@Command
	fun clearMasterUnlockKey(invoke: Invoke) {
		val args = invoke.parseArgs(UserIdArgs::class.java)
		ensureVaultStateManagerInitialized()
		Log.w(
			TAG,
			"clearMasterUnlockKey: CALLED from the webview bridge (userId='${args.userId}', " +
				"pid=${android.os.Process.myPid()})",
		)
		VaultStateManager.dumpDebugState("BEFORE clearMasterUnlockKey")
		if (args.userId.isNullOrBlank()) {
			VaultStateManager.clearAllMasterUnlockKeys()
		} else {
			VaultStateManager.clearMasterUnlockKey(args.userId!!)
		}
		VaultStateManager.dumpDebugState("AFTER clearMasterUnlockKey")
		emit("onVaultLocked")
		resolveValue(invoke, true)
	}

	/** Clear every Master Unlock Key (on logout, or when locking all accounts). */
	@Command
	fun clearAllMasterUnlockKeys(invoke: Invoke) {
		ensureVaultStateManagerInitialized()
		Log.w(
			TAG,
			"clearAllMasterUnlockKeys: CALLED from the webview bridge (pid=${android.os.Process.myPid()})",
		)
		VaultStateManager.dumpDebugState("BEFORE clearAllMasterUnlockKeys")
		VaultStateManager.clearAllMasterUnlockKeys()
		VaultStateManager.dumpDebugState("AFTER clearAllMasterUnlockKeys")
		emit("onVaultLocked")
		resolveValue(invoke, true)
	}

	/** Whether the vault is currently unlocked (MUK available). */
	@Command
	fun isVaultUnlocked(invoke: Invoke) {
		val args = invoke.parseArgs(UserIdArgs::class.java)
		ensureVaultStateManagerInitialized()
		Log.d(
			TAG,
			"isVaultUnlocked: CALLED from the webview bridge (userId='${args.userId}', " +
				"pid=${android.os.Process.myPid()})",
		)
		val unlocked = if (args.userId.isNullOrBlank()) {
			VaultStateManager.isUnlocked()
		} else {
			VaultStateManager.isUnlocked(args.userId!!)
		}
		if (!unlocked) {
			VaultStateManager.dumpDebugState("isVaultUnlocked=FALSE")
		}
		resolveValue(invoke, unlocked)
	}

	/**
	 * The MUK as Base64, for debugging/verification only.
	 * WARNING: only use in development builds.
	 */
	@Command
	fun getMasterUnlockKeyBase64(invoke: Invoke) {
		val args = invoke.parseArgs(UserIdArgs::class.java)
		ensureVaultStateManagerInitialized()
		val muk = if (args.userId.isNullOrBlank()) {
			VaultStateManager.getMasterUnlockKeyBase64()
		} else {
			VaultStateManager.getMasterUnlockKeyBase64(args.userId!!)
		}
		resolveValue(invoke, muk)
	}

	// ------------------------------------------------------------------
	// MUK escrow management (MukEscrowManager)
	// ------------------------------------------------------------------

	/**
	 * Escrow the MUK with biometric protection after a password unlock, so later unlocks
	 * need no password.
	 */
	@Command
	fun escrowMukWithBiometric(invoke: Invoke) {
		val args = invoke.parseArgs(EscrowMukArgs::class.java)
		ensureVaultStateManagerInitialized()
		val activity = currentActivity
		if (activity == null) {
			invoke.reject("No activity available", "NO_ACTIVITY")
			return
		}

		val email = args.email
		val userId = args.userId
		val timeoutMs = args.timeoutMs?.toLong() ?: MukEscrowManager.DEFAULT_ESCROW_TIMEOUT_MS

		if (email.isEmpty()) {
			invoke.reject("email is required", "INVALID_PARAMS")
			return
		}

		val muk = if (userId.isNullOrBlank()) {
			VaultStateManager.getMasterUnlockKey()
		} else {
			VaultStateManager.getMasterUnlockKey(userId)
		}
		if (muk == null) {
			invoke.reject("Vault is not unlocked", "VAULT_LOCKED")
			return
		}

		// Generate escrow key if needed
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
			mukEscrowManager.generateKey()
		}

		// Function to perform escrow after auth
		fun performEscrow(cipher: javax.crypto.Cipher) {
			pluginScope.launch {
				try {
					mukEscrowManager.escrowMuk(muk, cipher, email, timeoutMs, userId)
					Log.d(TAG, "escrowMukWithBiometric: MUK escrowed successfully for $email")
					resolveValue(invoke, true)
				} catch (e: Exception) {
					Log.e(TAG, "escrowMukWithBiometric: Failed to escrow MUK", e)
					invoke.reject("Failed to escrow MUK: ${e.message}", "ESCROW_FAILED", e)
				}
			}
		}

		activity.runOnUiThread {
			if (!canHostPrompt(activity)) {
				Log.e(TAG, "escrowMukWithBiometric: host activity cannot show a prompt")
				invoke.reject(
					"No activity able to show the biometric prompt",
					"NO_ACTIVITY",
				)
				return@runOnUiThread
			}
			try {
				val cipher = mukEscrowManager.getEncryptCipher()
				val executor = ContextCompat.getMainExecutor(context)

				val biometricPrompt = BiometricPrompt(
					activity,
					executor,
					object : BiometricPrompt.AuthenticationCallback() {
						override fun onAuthenticationSucceeded(
							result: BiometricPrompt.AuthenticationResult,
						) {
							result.cryptoObject?.cipher?.let { performEscrow(it) }
								?: invoke.reject("No cipher after authentication", "AUTH_ERROR")
						}

						override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
							invoke.reject(errString.toString(), "AUTH_ERROR")
						}

						override fun onAuthenticationFailed() {
							// Let user retry
						}
					},
				)

				val promptInfo = BiometricPrompt.PromptInfo.Builder()
					.setTitle("Enable Quick Unlock")
					.setSubtitle("Authenticate to enable biometric unlock")
					.setAllowedAuthenticators(
						BiometricManager.Authenticators.BIOMETRIC_STRONG or
							BiometricManager.Authenticators.DEVICE_CREDENTIAL,
					)
					.build()

				biometricPrompt.authenticate(promptInfo, BiometricPrompt.CryptoObject(cipher))
			} catch (e: Exception) {
				Log.e(TAG, "Failed to show biometric prompt for escrow", e)
				invoke.reject(
					"Failed to show authentication prompt: ${e.message}",
					"PROMPT_FAILED",
					e,
				)
			}
		}
	}

	/**
	 * Retrieve the escrowed MUK with biometric authentication, unlocking the vault
	 * without a password.
	 */
	@Command
	fun retrieveEscrowedMuk(invoke: Invoke) {
		ensureVaultStateManagerInitialized()
		val activity = currentActivity
		if (activity == null) {
			invoke.reject("No activity available", "NO_ACTIVITY")
			return
		}

		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
			invoke.reject("MUK escrow requires Android 6.0 or higher", "UNSUPPORTED")
			return
		}

		if (!mukEscrowManager.hasValidEscrow()) {
			invoke.reject("No valid MUK escrow available", "NO_ESCROW")
			return
		}

		// Function to perform retrieval after auth
		fun performRetrieval(cipher: javax.crypto.Cipher) {
			pluginScope.launch {
				try {
					val muk = mukEscrowManager.retrieveEscrowedMuk(cipher)
					val escrowUserId = mukEscrowManager.getEscrowUserId()
					if (escrowUserId.isNullOrBlank()) {
						VaultStateManager.setMasterUnlockKey(muk)
					} else {
						VaultStateManager.setMasterUnlockKey(escrowUserId, muk)
					}
					Log.d(TAG, "retrieveEscrowedMuk: MUK retrieved and set successfully")
					emit("onVaultUnlocked")
					resolveValue(invoke, true)
				} catch (e: Exception) {
					Log.e(TAG, "retrieveEscrowedMuk: Failed to retrieve MUK", e)
					invoke.reject("Failed to retrieve MUK: ${e.message}", "RETRIEVE_FAILED", e)
				}
			}
		}

		activity.runOnUiThread {
			if (!canHostPrompt(activity)) {
				Log.e(TAG, "retrieveEscrowedMuk: host activity cannot show a prompt")
				invoke.reject(
					"No activity able to show the biometric prompt",
					"NO_ACTIVITY",
				)
				return@runOnUiThread
			}
			try {
				val cipher = mukEscrowManager.getDecryptCipher()
				val executor = ContextCompat.getMainExecutor(context)

				val biometricPrompt = BiometricPrompt(
					activity,
					executor,
					object : BiometricPrompt.AuthenticationCallback() {
						override fun onAuthenticationSucceeded(
							result: BiometricPrompt.AuthenticationResult,
						) {
							result.cryptoObject?.cipher?.let { performRetrieval(it) }
								?: invoke.reject("No cipher after authentication", "AUTH_ERROR")
						}

						override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
							invoke.reject(errString.toString(), "AUTH_ERROR")
						}

						override fun onAuthenticationFailed() {
							// Let user retry
						}
					},
				)

				val promptInfo = BiometricPrompt.PromptInfo.Builder()
					.setTitle("Unlock Bittery")
					.setSubtitle("Authenticate to access your passwords")
					.setAllowedAuthenticators(
						BiometricManager.Authenticators.BIOMETRIC_STRONG or
							BiometricManager.Authenticators.DEVICE_CREDENTIAL,
					)
					.build()

				biometricPrompt.authenticate(promptInfo, BiometricPrompt.CryptoObject(cipher))
			} catch (e: Exception) {
				Log.e(TAG, "Failed to show biometric prompt for retrieval", e)
				invoke.reject(
					"Failed to show authentication prompt: ${e.message}",
					"PROMPT_FAILED",
					e,
				)
			}
		}
	}

	/** Whether there is a valid (non-expired) MUK escrow. */
	@Command
	fun hasValidEscrow(invoke: Invoke) {
		val value = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
			false
		} else {
			val hasEscrow = mukEscrowManager.hasValidEscrow()
			Log.d(TAG, "hasValidEscrow: $hasEscrow")
			hasEscrow
		}
		resolveValue(invoke, value)
	}

	/** Whether there is a valid escrow for a specific email. */
	@Command
	fun hasValidEscrowForEmail(invoke: Invoke) {
		val args = invoke.parseArgs(EmailArgs::class.java)
		val value = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
			false
		} else {
			mukEscrowManager.hasValidEscrowForEmail(args.email)
		}
		resolveValue(invoke, value)
	}

	/** Remaining escrow time, in milliseconds. */
	@Command
	fun getEscrowRemainingTime(invoke: Invoke) {
		val value = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
			0L
		} else {
			mukEscrowManager.getEscrowRemainingTime()
		}
		resolveValue(invoke, value)
	}

	/** Clear the MUK escrow (on logout, or when a password is required). */
	@Command
	fun clearEscrow(invoke: Invoke) {
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
			mukEscrowManager.clearEscrow()
		}
		Log.d(TAG, "clearEscrow: Escrow cleared")
		resolveValue(invoke, true)
	}

	// ------------------------------------------------------------------
	// 30-day master password re-entry
	// ------------------------------------------------------------------

	/** Whether master password re-entry is required (> 30 days since the last entry). */
	@Command
	fun isMasterPasswordReentryRequired(invoke: Invoke) {
		val value = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
			true // Always require password on old devices
		} else {
			mukEscrowManager.isMasterPasswordReentryRequired()
		}
		resolveValue(invoke, value)
	}

	/** Whether biometric unlock can be used — escrow validity and the 30-day check. */
	@Command
	fun canUseBiometricUnlock(invoke: Invoke) {
		val value = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
			false
		} else {
			mukEscrowManager.canUseBiometricUnlock()
		}
		resolveValue(invoke, value)
	}

	/** Record a successful password-based unlock. */
	@Command
	fun updateLastMasterPasswordEntry(invoke: Invoke) {
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
			mukEscrowManager.updateLastMasterPasswordEntry()
			Log.d(TAG, "updateLastMasterPasswordEntry: timestamp updated")
		}
		resolveValue(invoke, true)
	}

	/** The timestamp of the last master password entry. */
	@Command
	fun getLastMasterPasswordEntry(invoke: Invoke) {
		val value = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
			0L
		} else {
			mukEscrowManager.getLastMasterPasswordEntry()
		}
		resolveValue(invoke, value)
	}

	// ------------------------------------------------------------------
	// Credential provider API availability
	// ------------------------------------------------------------------

	/** Whether the Credential Manager API exists here. Needs Android 14 (API 34). */
	@Command
	fun isAvailable(invoke: Invoke) {
		val available = Build.VERSION.SDK_INT >= MIN_API
		Log.d(TAG, "isAvailable: $available (SDK ${Build.VERSION.SDK_INT}, min required: $MIN_API)")
		resolveValue(invoke, available)
	}

	/** Whether biometric authentication is available. */
	@Command
	fun isBiometricAvailable(invoke: Invoke) {
		val biometricManager = BiometricManager.from(context)
		val canAuthenticate = biometricManager.canAuthenticate(
			BiometricManager.Authenticators.BIOMETRIC_STRONG or
				BiometricManager.Authenticators.DEVICE_CREDENTIAL,
		)
		val available = canAuthenticate == BiometricManager.BIOMETRIC_SUCCESS
		Log.d(TAG, "isBiometricAvailable: $available (canAuthenticate result: $canAuthenticate)")
		resolveValue(invoke, available)
	}

	/**
	 * Open the Android system settings for credential providers. `true` means the
	 * credential-provider screen opened, `false` means it fell back to security settings.
	 */
	@Command
	fun openCredentialProviderSettings(invoke: Invoke) {
		val value = try {
			if (Build.VERSION.SDK_INT >= MIN_API) {
				val intent = Intent(Settings.ACTION_CREDENTIAL_PROVIDER)
				intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
				context.startActivity(intent)
				true
			} else {
				// Fallback to security settings on older Android versions
				val intent = Intent(Settings.ACTION_SECURITY_SETTINGS)
				intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
				context.startActivity(intent)
				false
			}
		} catch (e: Exception) {
			Log.e(TAG, "Failed to open settings", e)
			false
		}
		resolveValue(invoke, value)
	}

	/**
	 * Three independent facts, reported separately — the M2-C1 manifest-merge probe.
	 *
	 * `supported` is the API floor. `enabled` is the user's choice in system settings,
	 * and no amount of correct manifest merging turns it on. `serviceDeclared` is
	 * whether the manifest merge actually landed.
	 *
	 * The only command here that does not use the `value` convention: it answers a
	 * record of five fields, all of them the result, with no single value to wrap.
	 */
	@Command
	fun isSupported(invoke: Invoke) {
		val component = serviceComponent()
		val result = JSObject()
		result.put("apiLevel", Build.VERSION.SDK_INT)
		result.put("component", component.flattenToShortString())
		result.put("serviceDeclared", serviceDeclared(component))

		if (Build.VERSION.SDK_INT < MIN_API) {
			result.put("supported", false)
			result.put("enabled", false)
			result.put(
				"detail",
				"API ${Build.VERSION.SDK_INT} < $MIN_API — CredentialProviderService does not exist on this device",
			)
			invoke.resolve(result)
			return
		}

		result.put("supported", true)
		try {
			result.put("enabled", queryEnabled(component))
			result.put(
				"detail",
				"android.credentials.CredentialManager.isEnabledCredentialProviderService",
			)
		} catch (e: Exception) {
			// Fall back to the raw setting the platform writes when the user picks
			// providers. Hidden, but readable, and a stated answer beats a wrong one.
			val raw = try {
				Settings.Secure.getString(activity.contentResolver, "credential_service")
			} catch (_: Exception) {
				null
			}
			result.put("enabled", raw?.contains(SERVICE_CLASS) == true)
			result.put(
				"detail",
				"isEnabledCredentialProviderService threw ${e::class.java.simpleName}: ${e.message}; " +
					"fell back to Settings.Secure credential_service = ${raw ?: "(null)"}",
			)
		}
		invoke.resolve(result)
	}

	@RequiresApi(MIN_API)
	private fun queryEnabled(component: ComponentName): Boolean {
		val manager = activity.getSystemService(android.credentials.CredentialManager::class.java)
			?: return false
		return manager.isEnabledCredentialProviderService(component)
	}

	/**
	 * Asks the package manager whether the merged manifest carries the service. A
	 * `null` answer means the merge did not reach the APK, which is a different failure
	 * from the user not having switched the provider on.
	 */
	private fun serviceDeclared(component: ComponentName): Boolean = try {
		activity.packageManager.getServiceInfo(component, 0)
		true
	} catch (_: Exception) {
		false
	}

	// ------------------------------------------------------------------
	// Vault sync (Room — off the main thread)
	// ------------------------------------------------------------------

	/**
	 * Sync account KDF metadata, vault keys and items for the vault-based autofill
	 * system. Encrypted data is stored as it arrives; decryption happens on demand with
	 * the MUK, so no biometric prompt is needed here.
	 *
	 * `dataJson` carries `userId`, `email`, `secretKey`, a `kdfProfile`
	 * (`schemaVersion`/`algorithm`/`iterations`), `vaultKeys` and `items`. An incomplete
	 * profile is rejected.
	 */
	@Command
	fun syncVaultData(invoke: Invoke) {
		val args = invoke.parseArgs(SyncVaultDataArgs::class.java)
		ensureVaultStateManagerInitialized()
		Log.d(TAG, "syncVaultData called")

		pluginScope.launch {
			try {
				// Parse JSON string
				val jsonObject = JSONObject(args.dataJson)
				val userId = jsonObject.optString("userId", "")
				val email = jsonObject.optString("email", "")
				val secretKey = jsonObject.optString("secretKey", "")
				val kdfProfile = jsonObject.optJSONObject("kdfProfile")

				if (userId.isBlank() || email.isBlank() || secretKey.isBlank() || kdfProfile == null) {
					invoke.reject(
						"Complete account and KDF profile data is required",
						"INVALID_PARAMS",
					)
					return@launch
				}

				val kdfSchemaVersion = kdfProfile.optInt("schemaVersion", -1)
				val kdfAlgorithm = kdfProfile.optString("algorithm", "")
				val kdfIterations = kdfProfile.optInt("iterations", -1)
				if (
					kdfSchemaVersion != 1 ||
					kdfAlgorithm != "pbkdf2-sha256" ||
					kdfIterations !in 600_000..1_200_000
				) {
					invoke.reject("Invalid KDF profile", "INVALID_PARAMS")
					return@launch
				}

				val vaultKeysJson = jsonObject.optJSONArray("vaultKeys") ?: JSONArray()
				val itemsJson = jsonObject.optJSONArray("items") ?: JSONArray()

				// Convert JSONArray to List<Map<String, Any>>
				val vaultKeysData = (0 until vaultKeysJson.length()).map { i ->
					val obj = vaultKeysJson.getJSONObject(i)
					obj.keys().asSequence().associateWith { key -> obj.get(key) }
				}

				val itemsData = (0 until itemsJson.length()).map { i ->
					val obj = itemsJson.getJSONObject(i)
					obj.keys().asSequence().associateWith { key -> obj.get(key) }
				}

				Log.d(
					TAG,
					"syncVaultData: Syncing ${vaultKeysData.size} vault keys and " +
						"${itemsData.size} items for user $userId",
				)

				withContext(Dispatchers.IO) {
					// Real account synchronization always replaces nullable
					// placeholder profile metadata with a complete profile.
					val existingAuthData = database.authDataDao().getByUserId(userId)
					val authData = if (existingAuthData == null) {
						AuthDataEntity(
							email = email,
							userId = userId,
							secretKey = secretKey,
							srpSalt = "",
							publicKey = "",
							encryptedPrivateKey = "",
							encryptedPrivateKeyIv = "",
							kdfSchemaVersion = kdfSchemaVersion,
							kdfAlgorithm = kdfAlgorithm,
							kdfIterations = kdfIterations,
						)
					} else {
						existingAuthData.copy(
							email = email,
							secretKey = secretKey,
							kdfSchemaVersion = kdfSchemaVersion,
							kdfAlgorithm = kdfAlgorithm,
							kdfIterations = kdfIterations,
						)
					}
					database.authDataDao().insert(authData)

					// Parse and insert vault keys
					val vaultKeys = vaultKeysData.mapNotNull { keyData ->
						try {
							VaultKeyEntity(
								vaultId = keyData["vaultId"] as? String ?: return@mapNotNull null,
								userId = userId,
								vaultName = keyData["vaultName"] as? String ?: return@mapNotNull null,
								vaultType = keyData["vaultType"] as? String ?: return@mapNotNull null,
								encryptedKey = keyData["encryptedKey"] as? String
									?: return@mapNotNull null,
								encryptionIv = keyData["encryptionIv"] as? String
									?: return@mapNotNull null,
								encryptionAlgorithm = keyData["encryptionAlgorithm"] as? String
									?: return@mapNotNull null,
								role = keyData["role"] as? String ?: return@mapNotNull null,
								syncedAt = System.currentTimeMillis(),
								keyVersion = (keyData["keyVersion"] as? Number)?.toLong()
									?: return@mapNotNull null,
							)
						} catch (e: Exception) {
							Log.w(TAG, "Failed to parse vault key: ${keyData["vaultId"]}", e)
							null
						}
					}

					if (vaultKeys.isNotEmpty()) {
						database.vaultKeyDao().insertAll(vaultKeys)
						Log.d(TAG, "Inserted ${vaultKeys.size} vault keys")
					}

					// Parse and insert items
					val items = itemsData.mapNotNull { itemData ->
						try {
							val itemId = itemData["id"] as? String ?: return@mapNotNull null
							val vaultId = itemData["vaultId"] as? String ?: return@mapNotNull null
							val category = itemData["category"] as? String ?: return@mapNotNull null

							// Only sync login items
							if (category != "login") return@mapNotNull null

							@Suppress("UNCHECKED_CAST")
							val urls = itemData["urls"] as? List<String> ?: emptyList()
							val primaryDomain = urls.firstOrNull()
								?.let { DomainMatch.normalizeHost(it) }
								?.takeIf { it.isNotEmpty() }

							ItemEntity(
								id = itemId,
								vaultId = vaultId,
								userId = userId,
								category = category,
								displayTitle = itemData["displayTitle"] as? String ?: "",
								encryptedData = itemData["encryptedData"] as? String
									?: return@mapNotNull null,
								encryptionIv = itemData["encryptionIv"] as? String
									?: return@mapNotNull null,
								encryptionAlgorithm = itemData["encryptionAlgorithm"] as? String
									?: return@mapNotNull null,
								primaryDomain = primaryDomain,
								username = itemData["username"] as? String,
								iconUrl = itemData["iconUrl"] as? String,
								lastUsedAt = (itemData["lastUsedAt"] as? Number)?.toLong() ?: 0L,
								syncedAt = System.currentTimeMillis(),
								createdAt = (itemData["createdAt"] as? Number)?.toLong()
									?: System.currentTimeMillis(),
								updatedAt = (itemData["updatedAt"] as? Number)?.toLong()
									?: System.currentTimeMillis(),
								isFavorite = itemData["isFavorite"] as? Boolean ?: false,
								version = (itemData["version"] as? Number)?.toLong()
									?: return@mapNotNull null,
								lastModifiedBy = itemData["lastModifiedBy"] as? String,
								encryptionVersion = (itemData["encryptionVersion"] as? Number)?.toLong()
									?: return@mapNotNull null,
								encryptedByUserId = itemData["encryptedByUserId"] as? String
									?: return@mapNotNull null,
							)
						} catch (e: Exception) {
							Log.w(TAG, "Failed to parse item: ${itemData["id"]}", e)
							null
						}
					}

					if (items.isNotEmpty()) {
						database.itemDao().insertAll(items)
						Log.d(TAG, "Inserted ${items.size} items")
					}

					val itemById = items.associateBy { it.id }
					val mukForDomainRepair = VaultStateManager.getMasterUnlockKey(userId)

					// Insert domain mappings for each item
					var totalDomains = 0
					for (i in 0 until itemsJson.length()) {
						try {
							val item = itemsJson.getJSONObject(i)
							val itemId = item.optString("id", "")
							if (itemId.isEmpty()) continue

							val category = item.optString("category", "")
							if (category != "login") continue

							// Parse URLs array from JSON
							val urlsJson = item.optJSONArray("urls") ?: JSONArray()
							val urls = (0 until urlsJson.length()).map { index ->
								urlsJson.getString(index)
							}

							val domainsByValue = LinkedHashMap<String, ItemDomainEntity>()
							// Both the host and its registrable domain are indexed, and a
							// lookup queries both, so the SQL match is exactly
							// DomainMatch.matches - see the lookupKeys vectors.
							for (url in urls) {
								for (domain in DomainMatch.lookupKeys(url)) {
									if (!domainsByValue.containsKey(domain)) {
										domainsByValue[domain] = ItemDomainEntity(
											itemId = itemId,
											domain = domain,
											isPrimary = domainsByValue.isEmpty(),
											fullUrl = url,
										)
									}
								}
							}

							if (domainsByValue.isEmpty()) {
								val localItem = itemById[itemId]
								if (mukForDomainRepair != null && localItem != null) {
									val recoveredDomains =
										recoverDomainsFromEncryptedItem(localItem, mukForDomainRepair)
									for (domain in recoveredDomains) {
										if (!domainsByValue.containsKey(domain)) {
											domainsByValue[domain] = ItemDomainEntity(
												itemId = itemId,
												domain = domain,
												isPrimary = domainsByValue.isEmpty(),
												fullUrl = "https://$domain",
											)
										}
									}
								}
							}

							val domains = domainsByValue.values.toList()

							if (domains.isNotEmpty()) {
								database.itemDomainDao().replaceDomainsForItem(itemId, domains)
								totalDomains += domains.size
								Log.d(
									TAG,
									"Inserted ${domains.size} domains for item $itemId: " +
										"${domains.map { it.domain }}",
								)
							} else {
								Log.d(
									TAG,
									"Item $itemId still has no domains after repair, skipping domain mapping",
								)
							}
						} catch (e: Exception) {
							Log.w(TAG, "Failed to process domains for item at index $i", e)
						}
					}

					Log.d(TAG, "Inserted $totalDomains domain mappings")

					// Clean up vault keys that are no longer present
					val incomingVaultIds = vaultKeys.map { it.vaultId }.toSet()
					val existingVaultIds = database.vaultKeyDao().getVaultIdsByUserId(userId)
					val vaultKeysToDelete = existingVaultIds - incomingVaultIds

					var deletedVaultKeys = 0
					for (vaultId in vaultKeysToDelete) {
						database.vaultKeyDao().delete(vaultId, userId)
						deletedVaultKeys++
					}

					// Clean up items that are no longer present
					val incomingItemIds = items.map { it.id }.toSet()
					val existingItemIds = database.itemDao().getItemIdsByUserId(userId)
					val itemsToDelete = existingItemIds - incomingItemIds

					var deletedItems = 0
					for (itemId in itemsToDelete) {
						database.itemDao().deleteById(itemId)
						deletedItems++
					}

					Log.d(TAG, "Cleanup: Deleted $deletedVaultKeys vault keys, $deletedItems items")

					val result = JSObject()
					result.put("vaultKeys", vaultKeys.size)
					result.put("items", items.size)
					result.put("domains", totalDomains)
					result.put("deletedVaultKeys", deletedVaultKeys)
					result.put("deletedItems", deletedItems)

					Log.d(TAG, "syncVaultData complete: $result")
					resolveValue(invoke, result)
				}
			} catch (e: Exception) {
				Log.e(TAG, "syncVaultData failed", e)
				invoke.reject("Failed to sync vault data: ${e.message}", "SYNC_FAILED", e)
			}
		}
	}

	/** Queued passkey mutations awaiting durable server writeback. */
	@Command
	fun getPendingPasskeyMutations(invoke: Invoke) {
		val args = invoke.parseArgs(UserIdArgs::class.java)
		pluginScope.launch {
			try {
				val userId = args.userId
				val entities = withContext(Dispatchers.IO) {
					if (userId.isNullOrBlank()) {
						database.pendingPasskeyMutationDao().getAll()
					} else {
						database.pendingPasskeyMutationDao().getByUserId(userId)
					}
				}

				val result = JSArray()
				for (entity in entities) {
					val row = JSObject()
					row.put("id", entity.id)
					row.put("userId", entity.userId)
					row.put("vaultId", entity.vaultId)
					row.put("itemId", entity.itemId)
					row.put("operation", entity.operation)
					row.put("encryptedData", entity.encryptedData)
					row.put("encryptionIv", entity.encryptionIv)
					row.put("encryptionAlgorithm", entity.encryptionAlgorithm)
					row.put("baseVersion", entity.baseVersion)
					row.put("encryptionVersion", entity.encryptionVersion)
					row.put("encryptedByUserId", entity.encryptedByUserId)
					row.put("createdAt", entity.createdAt)
					row.put("attemptCount", entity.attemptCount)
					// JSONObject.put(key, null) *removes* the key, so a null lastError has
					// to be spelled out — the field is declared on the TypeScript side.
					row.put("lastError", entity.lastError ?: JSONObject.NULL)
					result.put(row)
				}

				resolveValue(invoke, result)
			} catch (e: Exception) {
				Log.e(TAG, "Failed to fetch pending passkey mutations", e)
				invoke.reject(
					"Failed to fetch pending passkey mutations: ${e.message}",
					"GET_PENDING_PASSKEY_MUTATIONS_FAILED",
					e,
				)
			}
		}
	}

	/** Mark queued passkey mutations as applied, dropping them from the local queue. */
	@Command
	fun markPendingPasskeyMutationsApplied(invoke: Invoke) {
		val args = invoke.parseArgs(IdsArgs::class.java)
		pluginScope.launch {
			try {
				if (args.ids.isNotEmpty()) {
					withContext(Dispatchers.IO) {
						database.pendingPasskeyMutationDao().deleteByIds(args.ids)
					}
				}
				resolveValue(invoke, true)
			} catch (e: Exception) {
				Log.e(TAG, "Failed to mark pending passkey mutations as applied", e)
				invoke.reject(
					"Failed to mark pending passkey mutations as applied: ${e.message}",
					"MARK_PENDING_PASSKEY_MUTATIONS_APPLIED_FAILED",
					e,
				)
			}
		}
	}

	/** Mark queued passkey mutations as failed — increments attempts, stores the error. */
	@Command
	fun markPendingPasskeyMutationsFailed(invoke: Invoke) {
		val args = invoke.parseArgs(IdsWithErrorArgs::class.java)
		pluginScope.launch {
			try {
				if (args.ids.isNotEmpty()) {
					withContext(Dispatchers.IO) {
						database.pendingPasskeyMutationDao().markFailed(args.ids, args.error)
					}
				}
				resolveValue(invoke, true)
			} catch (e: Exception) {
				Log.e(TAG, "Failed to mark pending passkey mutations as failed", e)
				invoke.reject(
					"Failed to mark pending passkey mutations as failed: ${e.message}",
					"MARK_PENDING_PASSKEY_MUTATIONS_FAILED",
					e,
				)
			}
		}
	}

	// ------------------------------------------------------------------
	// Helpers carried over unchanged
	// ------------------------------------------------------------------

	private fun collectCandidateDomainsFromItemJson(itemDataJson: JSONObject): List<String> {
		val domains = LinkedHashSet<String>()

		domains.addAll(DomainMatch.lookupKeys(itemDataJson.optString("url")))

		val urlsJson = itemDataJson.optJSONArray("urls")
		if (urlsJson != null) {
			for (index in 0 until urlsJson.length()) {
				domains.addAll(DomainMatch.lookupKeys(urlsJson.optString(index, "")))
			}
		}

		val passkeysJson = itemDataJson.optJSONArray("passkeys")
		if (passkeysJson != null) {
			for (index in 0 until passkeysJson.length()) {
				val passkey = passkeysJson.optJSONObject(index) ?: continue
				domains.addAll(DomainMatch.lookupKeys(passkey.optString("rpId", "")))
			}
		}

		return domains.toList()
	}

	private suspend fun recoverDomainsFromEncryptedItem(
		itemEntity: ItemEntity,
		muk: ByteArray,
	): List<String> {
		return try {
			val vaultKey = database.vaultKeyDao().getByVaultId(itemEntity.vaultId, itemEntity.userId)
				?: return emptyList()
			val decryptedVaultKey = VaultDecryptor.decryptVaultKeyWithMuk(vaultKey, muk)
			val itemDataJson = VaultDecryptor.decryptItemJson(itemEntity, decryptedVaultKey)
			collectCandidateDomainsFromItemJson(itemDataJson)
		} catch (e: Exception) {
			Log.w(TAG, "Failed to recover domains from encrypted item ${itemEntity.id}", e)
			emptyList()
		}
	}

	/**
	 * The Expo module's `sendEvent(name, mapOf("success" to true))`.
	 *
	 * Tauri delivers plugin events over a `Channel` a listener has registered, so with
	 * no listener this is a no-op — which is the state today, and why the emit is kept
	 * rather than dropped: the moment the next chunk registers a listener, the same two
	 * events fire at the same two moments they always did.
	 */
	private fun emit(event: String) {
		val payload = JSObject()
		payload.put("success", true)
		trigger(event, payload)
	}
}
