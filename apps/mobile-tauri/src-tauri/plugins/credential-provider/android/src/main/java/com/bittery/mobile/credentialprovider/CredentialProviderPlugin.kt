package com.bittery.mobile.credentialprovider

import android.app.Activity
import android.content.ComponentName
import android.os.Build
import android.provider.Settings
import androidx.annotation.RequiresApi
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

private const val MIN_API = Build.VERSION_CODES.UPSIDE_DOWN_CAKE // 34

/** Must match `.service.BitteryCredentialProviderService` in the plugin manifest. */
private const val SERVICE_CLASS =
	"com.bittery.mobile.credentialprovider.service.BitteryCredentialProviderService"

/**
 * The Tauri bridge into the ported credential provider.
 *
 * **One command on purpose.** This chunk moved ~7 900 lines of Kotlin out of the Expo
 * module and into a Tauri plugin; the command surface that replaces
 * `CredentialProviderModule.kt` — vault sync, MUK escrow, passkey mutations — is the
 * next chunk. [isSupported] exists so the plugin registers, so the Kotlin is proven to
 * compile and load, and so the merged manifest can be checked from inside the app.
 *
 * Everything the *system* calls — the two services and their activities — is already
 * live and does not route through this class. It is reached by intent, not by command.
 */
@TauriPlugin
class CredentialProviderPlugin(private val activity: Activity) : Plugin(activity) {

	private fun serviceComponent(): ComponentName =
		ComponentName(activity.applicationContext.packageName, SERVICE_CLASS)

	/**
	 * Three independent facts, reported separately.
	 *
	 * `supported` is the API floor. `enabled` is the user's choice in system settings,
	 * and no amount of correct manifest merging turns it on. `serviceDeclared` is
	 * whether the manifest merge actually landed — the thing this chunk had to prove.
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
}
