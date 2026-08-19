package com.bittery.mobile.credentialprovider

import android.app.Activity
import android.app.Application
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Base64
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
import com.bittery.mobile.credentialprovider.vault.AndroidVaultLogger
import com.bittery.mobile.credentialprovider.vault.CredentialReplicaSnapshots
import com.bittery.mobile.credentialprovider.vault.DEFAULT_BIOMETRIC_UNLOCK_TIMEOUT_MS
import com.bittery.mobile.credentialprovider.vault.EnrolResult
import com.bittery.mobile.credentialprovider.vault.NativeCredentialVaults
import com.bittery.mobile.credentialprovider.vault.ReplicaSnapshotParse
import com.bittery.mobile.credentialprovider.vault.ReplicaUpdateResult
import com.bittery.mobile.credentialprovider.vault.UnlockResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject

private const val TAG = "CredentialProviderPlugin"

private const val MIN_API = Build.VERSION_CODES.UPSIDE_DOWN_CAKE // 34

/** Must match `.service.BitteryCredentialProviderService` in the plugin manifest. */
private const val SERVICE_CLASS =
	"com.bittery.mobile.credentialprovider.service.BitteryCredentialProviderService"

/**
 * The Tauri bridge into the ported credential provider.
 *
 * This is a bridge and nothing else. Every command parses its arguments, asks
 * [NativeCredentialVault][com.bittery.mobile.credentialprovider.vault.NativeCredentialVault]
 * one question, and turns the answer into a `JSObject` or a rejection. The live keys,
 * the escrow, the replica and the cryptography live in the vault; this class does not
 * coordinate them and must not start. A behaviour change here is a security change,
 * because this class hands out the master unlock key.
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
 * which is where the Expo module's synchronous `Function`s ran too. The commands that
 * reach the replica or a prompt are `suspend` calls on the vault: they launch on
 * [pluginScope] and resolve from the coroutine when the vault answers. The vault moves
 * its own storage work off the main thread, so nothing here blocks it.
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

	/** The *server* user id, for queries against the local Room cache. */
	@InvokeArg
	class UserIdArgs {
		var userId: String? = null
	}

	/**
	 * The account id, which is what live unlock state is keyed by.
	 *
	 * There is no fallback value. A blank id is a caller bug, and the old
	 * `"default"` stand-in let one account read another's vault.
	 */
	@InvokeArg
	class AccountIdArgs {
		var accountId: String? = null
	}

	/**
	 * The account id, required rather than optional.
	 *
	 * A command that answers "no live key" for a *missing* id looks exactly like one
	 * answering it for a locked vault, and the caller never learns it asked the wrong
	 * question. [borrowLiveMasterUnlockKeyBase64] names its account or is rejected.
	 */
	@InvokeArg
	class RequiredAccountIdArgs {
		var accountId: String = ""
	}

	@InvokeArg
	class SetMasterUnlockKeyArgs {
		var mukBase64: String = ""
		var accountId: String? = null
		var userId: String? = null
		var autoLockTimeoutMs: Double? = null
	}

	@InvokeArg
	class SetMukAutoLockTimeoutArgs {
		var timeoutMs: Double = 0.0
		var accountId: String? = null
	}

	@InvokeArg
	class EscrowMukArgs {
		var email: String = ""
		var accountId: String? = null
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

	@InvokeArg
	class AuthenticateArgs {
		var reason: String = ""
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
	 * vault outlives any one activity, so an activity context here would leak it.
	 */
	private val context: Context
		get() = activity.applicationContext

	/**
	 * The process-wide vault. The same instance the two services and the two
	 * activities use, because they all run in this process — `PROCESS-MODEL.md`.
	 */
	private val vault by lazy { NativeCredentialVaults.of(context) }

	/** Sync payloads report their own skipped records. */
	private val snapshotLogger = AndroidVaultLogger(TAG)

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



	/** The one resolve shape: `{ "value": <result> }`. See the class comment. */
	private fun resolveValue(invoke: Invoke, value: Any?) {
		val result = JSObject()
		result.put("value", value ?: JSONObject.NULL)
		invoke.resolve(result)
	}

	private fun serviceComponent(): ComponentName =
		ComponentName(activity.applicationContext.packageName, SERVICE_CLASS)

	// ------------------------------------------------------------------
	// Live unlock state
	//
	// Every command names an account. There is no fallback id: a blank one is
	// rejected, because the old `"default"` stand-in pooled every account's key
	// under one name. Nothing here logs an id, a key or a key length.
	// ------------------------------------------------------------------

	private fun requireAccountId(invoke: Invoke, accountId: String?): String? {
		if (accountId.isNullOrBlank()) {
			invoke.reject("accountId is required", "INVALID_PARAMS")
			return null
		}
		return accountId
	}

	/**
	 * Hand the app's already-unlocked key to the vault, so the credential
	 * provider services can decrypt while the app is unlocked.
	 *
	 * Live only. Nothing is written to disk, so an auto-lock or a restart really
	 * does lose it.
	 */
	@Command
	fun setMasterUnlockKey(invoke: Invoke) {
		val args = invoke.parseArgs(SetMasterUnlockKeyArgs::class.java)
		val accountId = requireAccountId(invoke, args.accountId) ?: return
		val serverUserId = args.userId
		if (serverUserId.isNullOrBlank()) {
			invoke.reject("userId is required", "INVALID_PARAMS")
			return
		}

		var muk: ByteArray? = null
		try {
			muk = Base64.decode(args.mukBase64, Base64.NO_WRAP)
			vault.acceptUnlockedKey(
				accountId = accountId,
				serverUserId = serverUserId,
				muk = muk,
				autoLockTimeoutMs = args.autoLockTimeoutMs?.toLong(),
			)
			emit("onVaultUnlocked")
			resolveValue(invoke, true)
		} catch (e: Exception) {
			Log.e(TAG, "setMasterUnlockKey: rejected (${e::class.java.simpleName})")
			resolveValue(invoke, false)
		} finally {
			muk?.fill(0)
		}
	}

	/** Update the auto-lock timeout for one account, applied immediately. */
	@Command
	fun setMukAutoLockTimeout(invoke: Invoke) {
		val args = invoke.parseArgs(SetMukAutoLockTimeoutArgs::class.java)
		val accountId = requireAccountId(invoke, args.accountId) ?: return
		try {
			vault.setAutoLockTimeout(accountId, args.timeoutMs.toLong())
			resolveValue(invoke, true)
		} catch (e: Exception) {
			Log.e(TAG, "setMukAutoLockTimeout: rejected (${e::class.java.simpleName})")
			resolveValue(invoke, false)
		}
	}

	/** Lock one account, or every account when no id is given. */
	@Command
	fun clearMasterUnlockKey(invoke: Invoke) {
		val args = invoke.parseArgs(AccountIdArgs::class.java)
		try {
			vault.lock(args.accountId?.takeIf { it.isNotBlank() })
			emit("onVaultLocked")
			resolveValue(invoke, true)
		} catch (e: Exception) {
			Log.e(TAG, "clearMasterUnlockKey: rejected (${e::class.java.simpleName})")
			resolveValue(invoke, false)
		}
	}

	/** Lock every account (on logout, or when locking all accounts). */
	@Command
	fun clearAllMasterUnlockKeys(invoke: Invoke) {
		vault.lock(null)
		emit("onVaultLocked")
		resolveValue(invoke, true)
	}

	/** Whether an account — or any account, with no id — has a live key. */
	@Command
	fun isVaultUnlocked(invoke: Invoke) {
		val args = invoke.parseArgs(AccountIdArgs::class.java)
		val accountId = args.accountId
		val unlocked = try {
			if (accountId.isNullOrBlank()) {
				vault.unlockedAccountIds().isNotEmpty()
			} else {
				vault.isUnlocked(accountId)
			}
		} catch (e: Exception) {
			Log.e(TAG, "isVaultUnlocked: rejected (${e::class.java.simpleName})")
			false
		}
		resolveValue(invoke, unlocked)
	}

	/**
	 * The live key as Base64, for debugging/verification only.
	 * WARNING: only use in development builds.
	 */
	@Command
	fun getMasterUnlockKeyBase64(invoke: Invoke) {
		val args = invoke.parseArgs(AccountIdArgs::class.java)
		val accountId = requireAccountId(invoke, args.accountId) ?: return
		val muk = try {
			vault.borrowLiveMasterUnlockKey(accountId)
		} catch (e: Exception) {
			invoke.reject("Invalid accountId", "INVALID_PARAMS")
			return
		}
		if (muk == null) {
			resolveValue(invoke, null)
			return
		}
		try {
			resolveValue(invoke, Base64.encodeToString(muk, Base64.NO_WRAP))
		} finally {
			muk.fill(0)
		}
	}

	/**
	 * The live key of one account as Base64, or `null` when there is none.
	 *
	 * The app calls this on boot. Bittery's own autofill and credential-provider
	 * activities unlock in this process and leave the key in the vault; until this
	 * existed nothing above the bridge could see that, so the app answered a
	 * biometric unlock the user had just passed with its own lock screen.
	 *
	 * **Live only, and that is the whole contract.** It reads the live keys and
	 * nothing else: no escrow, no prompt, no disk. So `null` means "no live key" —
	 * a lock, an auto-lock or a process restart all produce it — and can never mean
	 * "we could get one by asking the user". Restoring a key after that costs a
	 * biometric prompt, which only an activity may show; see `PROCESS-MODEL.md`.
	 *
	 * The borrowed array is blanked before this returns, on both paths.
	 */
	@Command
	fun borrowLiveMasterUnlockKeyBase64(invoke: Invoke) {
		val args = invoke.parseArgs(RequiredAccountIdArgs::class.java)
		val accountId = requireAccountId(invoke, args.accountId) ?: return
		val muk = try {
			vault.borrowLiveMasterUnlockKey(accountId)
		} catch (e: Exception) {
			invoke.reject("Invalid accountId", "INVALID_PARAMS")
			return
		}
		if (muk == null) {
			resolveValue(invoke, null)
			return
		}
		try {
			resolveValue(invoke, Base64.encodeToString(muk, Base64.NO_WRAP))
		} finally {
			muk.fill(0)
		}
	}

	// ------------------------------------------------------------------
	// Biometric unlock
	// ------------------------------------------------------------------

	/**
	 * Wrap the in-memory MUK so a later autofill unlock can unwrap it with
	 * biometrics. The wrap uses a public key, so this shows no prompt. The command
	 * name is historical; the ACL identity stays.
	 */
	@Command
	fun escrowMukWithBiometric(invoke: Invoke) {
		val args = invoke.parseArgs(EscrowMukArgs::class.java)

		val email = args.email
		val serverUserId = args.userId
		val timeoutMs = args.timeoutMs?.toLong() ?: DEFAULT_BIOMETRIC_UNLOCK_TIMEOUT_MS

		if (email.isEmpty()) {
			invoke.reject("email is required", "INVALID_PARAMS")
			return
		}

		val accountId = requireAccountId(invoke, args.accountId) ?: return
		if (serverUserId.isNullOrBlank()) {
			invoke.reject("userId is required", "INVALID_PARAMS")
			return
		}

		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
			invoke.reject("MUK escrow requires Android 6.0 or higher", "UNSUPPORTED")
			return
		}

		pluginScope.launch {
			val result = try {
				vault.enrolBiometricUnlock(
					accountId = accountId,
					serverUserId = serverUserId,
					email = email,
					timeoutMs = timeoutMs,
				)
			} catch (e: IllegalArgumentException) {
				invoke.reject("Invalid accountId", "INVALID_PARAMS")
				return@launch
			}

			when (result) {
				EnrolResult.Enrolled -> {
					Log.d(TAG, "escrowMukWithBiometric: key wrapped")
					resolveValue(invoke, true)
				}

				EnrolResult.VaultLocked ->
					invoke.reject("Vault is not unlocked", "VAULT_LOCKED")

				is EnrolResult.Failed -> {
					Log.e(TAG, "escrowMukWithBiometric: Failed to escrow MUK", result.cause)
					invoke.reject(
						"Failed to escrow MUK: ${result.message}",
						"ESCROW_FAILED",
						result.cause,
					)
				}
			}
		}
	}

	/**
	 * Retrieve the escrowed MUK with biometric authentication, unlocking the vault
	 * without a password.
	 */
	@Command
	fun retrieveEscrowedMuk(invoke: Invoke) {
		val activity = currentActivity
		if (activity == null) {
			invoke.reject("No activity available", "NO_ACTIVITY")
			return
		}

		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
			invoke.reject("MUK escrow requires Android 6.0 or higher", "UNSUPPORTED")
			return
		}

		pluginScope.launch {
			when (
				val result = vault.unlockWithBiometric(
					activity,
					"Authenticate to access your passwords",
				)
			) {
				is UnlockResult.Unlocked -> {
					Log.d(TAG, "retrieveEscrowedMuk: key unwrapped")
					emit("onVaultUnlocked")
					resolveValue(invoke, true)
				}

				UnlockResult.NoEscrow ->
					invoke.reject("No valid MUK escrow available", "NO_ESCROW")

				// A record written before the account-id rekey. Re-enrol instead.
				UnlockResult.NeedsReenrolment ->
					invoke.reject("Escrow needs re-enrolment", "NO_ESCROW")

				is UnlockResult.Rejected -> invoke.reject(result.message, "AUTH_ERROR")

				is UnlockResult.PromptUnavailable -> {
					Log.e(TAG, "retrieveEscrowedMuk: host activity cannot show a prompt")
					invoke.reject(result.message, "NO_ACTIVITY")
				}

				is UnlockResult.PromptFailed -> {
					Log.e(TAG, "Failed to show biometric prompt for retrieval")
					invoke.reject(result.message, "PROMPT_FAILED")
				}

				is UnlockResult.Failed -> {
					Log.e(TAG, "retrieveEscrowedMuk: Failed to retrieve MUK", result.cause)
					invoke.reject(
						"Failed to retrieve MUK: ${result.message}",
						"RETRIEVE_FAILED",
						result.cause,
					)
				}
			}
		}
	}

	/** Whether there is a valid (non-expired) MUK escrow. */
	@Command
	fun hasValidEscrow(invoke: Invoke) {
		val value = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
			false
		} else {
			val hasEscrow = vault.biometricUnlockState().hasEscrow
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
			vault.hasBiometricUnlockFor(args.email)
		}
		resolveValue(invoke, value)
	}

	/** Remaining escrow time, in milliseconds. */
	@Command
	fun getEscrowRemainingTime(invoke: Invoke) {
		val value = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
			0L
		} else {
			vault.biometricUnlockState().remainingMs
		}
		resolveValue(invoke, value)
	}

	/** Clear the MUK escrow (on logout, or when a password is required). */
	@Command
	fun clearEscrow(invoke: Invoke) {
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
			vault.forgetBiometricUnlock()
		}
		Log.d(TAG, "clearEscrow: Escrow cleared")
		resolveValue(invoke, true)
	}

	/**
	 * Clear the MUK escrow only when it belongs to this account.
	 *
	 * The escrow is one slot. Signing one account out must not cost another
	 * account the biometric unlock it enrolled.
	 */
	@Command
	fun clearEscrowForAccount(invoke: Invoke) {
		val args = invoke.parseArgs(RequiredAccountIdArgs::class.java)
		val cleared = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
			false
		} else {
			vault.forgetBiometricUnlockFor(args.accountId)
		}
		Log.d(TAG, "clearEscrowForAccount: cleared=$cleared")
		resolveValue(invoke, cleared)
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
			vault.biometricUnlockState().masterPasswordRequired
		}
		resolveValue(invoke, value)
	}

	/** Whether biometric unlock can be used — escrow validity and the 30-day check. */
	@Command
	fun canUseBiometricUnlock(invoke: Invoke) {
		val value = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
			false
		} else {
			vault.biometricUnlockState().canUnlock
		}
		resolveValue(invoke, value)
	}

	/** Record a successful password-based unlock. */
	@Command
	fun updateLastMasterPasswordEntry(invoke: Invoke) {
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
			vault.recordMasterPasswordEntry()
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
			vault.biometricUnlockState().lastMasterPasswordEntryMs
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
	 * Presence-only biometric prompt on the live [MainActivity][boundActivity].
	 *
	 * The third-party biometry plugin starts a translucent `BiometryActivity` through
	 * `startActivityForResult`. That path never shows a sheet here (Tauri 2.11 launcher,
	 * floating theme). This command reuses the activity tracker and [canHostPrompt]
	 * already required for MUK escrow.
	 */
	@Command
	fun authenticate(invoke: Invoke) {
		val args = invoke.parseArgs(AuthenticateArgs::class.java)
		val activity = currentActivity
		if (activity == null) {
			invoke.reject("No activity available", "NO_ACTIVITY")
			return
		}
		activity.runOnUiThread {
			if (!canHostPrompt(activity)) {
				Log.e(TAG, "authenticate: host activity cannot show a prompt")
				invoke.reject(
					"No activity able to show the biometric prompt",
					"NO_ACTIVITY",
				)
				return@runOnUiThread
			}
			try {
				val executor = ContextCompat.getMainExecutor(context)
				val biometricPrompt = BiometricPrompt(
					activity,
					executor,
					object : BiometricPrompt.AuthenticationCallback() {
						override fun onAuthenticationSucceeded(
							result: BiometricPrompt.AuthenticationResult,
						) {
							resolveValue(invoke, true)
						}

						override fun onAuthenticationError(
							errorCode: Int,
							errString: CharSequence,
						) {
							// Code is English so the JS classifier still matches a German
							// OS string. Tauri flattens this to "[code] - message".
							invoke.reject(
								errString.toString(),
								BiometricErrorCodes.fromPrompt(errorCode),
							)
						}

						override fun onAuthenticationFailed() {
							// Let the user retry.
						}
					},
				)
				val title = args.reason.ifBlank { "Unlock Bittery" }
				val promptInfo = BiometricPrompt.PromptInfo.Builder()
					.setTitle(title)
					.setNegativeButtonText("Cancel")
					.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_WEAK)
					.setConfirmationRequired(false)
					.build()
				biometricPrompt.authenticate(promptInfo)
			} catch (e: Exception) {
				Log.e(TAG, "Failed to show biometric prompt", e)
				invoke.reject(
					"Failed to show authentication prompt: ${e.message}",
					"PROMPT_FAILED",
					e,
				)
			}
		}
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
	// The local replica (off the main thread, inside the vault)
	// ------------------------------------------------------------------

	/**
	 * Replace the local replica with what the server just sent: account KDF
	 * metadata, vault keys and login items. Everything arrives encrypted and is
	 * stored as it arrives, so no biometric prompt is needed here.
	 *
	 * `dataJson` carries `accountId`, `userId`, `email`, `secretKey`, a
	 * `kdfProfile` (`schemaVersion`/`algorithm`/`iterations`), `vaultKeys`, `items`
	 * and a `travelMode` policy (`verified`/`enabled`/`hiddenVaultIds`/`updatedAt`).
	 * An incomplete payload is rejected and nothing is written, and so is one whose
	 * policy is missing or unverified — the account then serves nothing until a
	 * verified policy arrives.
	 */
	@Command
	fun syncVaultData(invoke: Invoke) {
		val args = invoke.parseArgs(SyncVaultDataArgs::class.java)
		Log.d(TAG, "syncVaultData called")

		pluginScope.launch {
			try {
				val parsed = CredentialReplicaSnapshots.parse(args.dataJson, snapshotLogger)
				if (parsed is ReplicaSnapshotParse.Rejected) {
					invoke.reject(parsed.reason, "INVALID_PARAMS")
					return@launch
				}

				val snapshot = (parsed as ReplicaSnapshotParse.Parsed).snapshot
				Log.d(
					TAG,
					"syncVaultData: Syncing ${snapshot.vaultKeys.size} vault keys and " +
						"${snapshot.items.size} items",
				)

				when (val outcome = vault.replaceReplica(snapshot)) {
					is ReplicaUpdateResult.Rejected ->
						invoke.reject(outcome.reason, "INVALID_PARAMS")

					is ReplicaUpdateResult.Applied -> {
						val result = JSObject()
						result.put("vaultKeys", outcome.vaultKeys)
						result.put("items", outcome.items)
						result.put("domains", outcome.domains)
						result.put("deletedVaultKeys", outcome.deletedVaultKeys)
						result.put("deletedItems", outcome.deletedItems)

						Log.d(TAG, "syncVaultData complete: $result")
						resolveValue(invoke, result)
					}
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
				val result = JSArray()
				for (mutation in vault.queuedVaultWrites(args.userId)) {
					val row = JSObject()
					row.put("id", mutation.id)
					row.put("userId", mutation.serverUserId)
					row.put("vaultId", mutation.vaultId)
					row.put("itemId", mutation.itemId)
					row.put("operation", mutation.operation)
					row.put("encryptedData", mutation.encryptedData)
					row.put("encryptionIv", mutation.encryptionIv)
					row.put("encryptionAlgorithm", mutation.encryptionAlgorithm)
					row.put("baseVersion", mutation.baseVersion)
					row.put("encryptionVersion", mutation.encryptionVersion)
					row.put("encryptedByUserId", mutation.encryptedByServerUserId)
					row.put("createdAt", mutation.createdAtMs)
					row.put("attemptCount", mutation.attemptCount)
					// JSONObject.put(key, null) *removes* the key, so a null lastError has
					// to be spelled out — the field is declared on the TypeScript side.
					row.put("lastError", mutation.lastError ?: JSONObject.NULL)
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
				vault.forgetQueuedVaultWrites(args.ids)
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
				vault.recordQueuedVaultWriteFailure(args.ids, args.error)
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
