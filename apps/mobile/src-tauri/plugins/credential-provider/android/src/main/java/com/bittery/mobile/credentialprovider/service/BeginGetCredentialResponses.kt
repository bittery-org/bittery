package com.bittery.mobile.credentialprovider.service

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.credentials.provider.AuthenticationAction
import androidx.credentials.provider.BeginGetCredentialRequest
import androidx.credentials.provider.BeginGetCredentialResponse
import androidx.credentials.provider.BeginGetPasswordOption
import androidx.credentials.provider.BeginGetPublicKeyCredentialOption
import androidx.credentials.provider.CredentialEntry
import androidx.credentials.provider.PasswordCredentialEntry
import androidx.credentials.provider.PublicKeyCredentialEntry
import com.bittery.mobile.credentialprovider.activity.GetCredentialsActivity
import com.bittery.mobile.credentialprovider.passkey.PasskeyUtils
import com.bittery.mobile.credentialprovider.vault.NativeCredentialVault
import com.bittery.mobile.credentialprovider.vault.PasskeySuggestion
import com.bittery.mobile.credentialprovider.vault.PasswordSuggestion
import java.time.Instant
import org.json.JSONArray

/**
 * What Bittery answers a `BeginGetCredentialRequest` with.
 *
 * Two callers build this same response. The service builds it when an app asks,
 * and [GetCredentialsActivity] builds it *again* after "Unlock Bittery": an
 * `AuthenticationAction` must hand the framework a fresh response, or the user
 * unlocks and still sees nothing. One builder, so the two can never drift.
 *
 * Entries carry no secret. A password is decrypted only after the user picks an
 * entry, in [GetCredentialsActivity].
 */
@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
internal class BeginGetCredentialResponses(
    private val context: Context,
    /** The caller's log tag, so one flow reads as one stream in logcat. */
    private val tag: String,
) {

    /**
     * Every entry this request may show, plus the unlock action when it needs one.
     *
     * Live keys only. Without one the response carries the authentication action
     * and no entries — a locked vault names nothing it holds.
     */
    suspend fun build(
        vault: NativeCredentialVault,
        request: BeginGetCredentialRequest,
        callingOrigin: String,
    ): BeginGetCredentialResponse {
        val isVaultUnlocked = vault.unlockedAccountIds().isNotEmpty()
        val credentialEntries = mutableListOf<CredentialEntry>()
        val authenticationActions = mutableListOf<AuthenticationAction>()

        if (!isVaultUnlocked) {
            Log.d(tag, "Vault is locked, adding authentication action")
            authenticationActions.add(
                AuthenticationAction("Unlock Bittery", unlockPendingIntent()),
            )
        }

        for (option in request.beginGetCredentialOptions) {
            Log.d(tag, "Processing option: ${option::class.simpleName}")
            if (option is BeginGetPasswordOption) {
                Log.d(tag, "Password request for origin: $callingOrigin")

                if (!isVaultUnlocked) {
                    Log.d(tag, "Vault locked - not returning credentials, only auth action")
                    continue
                }

                val suggestions = vault.passwordSuggestionsForOrigin(callingOrigin)
                Log.d(tag, "Found ${suggestions.size} items for the calling origin")
                for (suggestion in suggestions) {
                    credentialEntries.add(passwordEntry(suggestion, option))
                }
            } else if (option is BeginGetPublicKeyCredentialOption) {
                val requestRpId = PasskeyUtils.parseRpIdFromGetRequestJson(option.requestJson)
                val fallbackDomain = passkeyRpIdFromOrigin(callingOrigin)
                val rpId = requestRpId?.takeIf { it.isNotBlank() } ?: fallbackDomain

                if (rpId.isBlank()) {
                    Log.w(tag, "Passkey option missing rpId/domain, skipping entry generation")
                    continue
                }

                if (!isVaultUnlocked) {
                    Log.d(tag, "Vault locked - not returning passkey entries, only auth action")
                    continue
                }

                val suggestions = vault.passkeySuggestionsFor(
                    rpId = rpId,
                    allowedCredentialIds = PasskeyUtils
                        .parseAllowCredentialIdsFromGetRequestJson(option.requestJson),
                )

                if (suggestions.isEmpty()) {
                    Log.d(tag, "No matching passkeys found for rpId=$rpId")
                } else {
                    Log.d(tag, "Adding ${suggestions.size} passkey entries for rpId=$rpId")
                    credentialEntries.addAll(suggestions.map { passkeyEntry(it, option) })
                }
            }
        }

        Log.d(
            tag,
            "Returning ${credentialEntries.size} credential entries and " +
                "${authenticationActions.size} auth actions",
        )

        val builder = BeginGetCredentialResponse.Builder()
            .setCredentialEntries(credentialEntries)
        if (authenticationActions.isNotEmpty()) {
            builder.setAuthenticationActions(authenticationActions)
        }
        return builder.build()
    }

    // ------------------------------------------------------------------
    // Entries
    // ------------------------------------------------------------------

    /**
     * One password entry. The label comes from the vault; the password does not
     * — the item is only decrypted after the user picks this entry.
     */
    private fun passwordEntry(
        suggestion: PasswordSuggestion,
        option: BeginGetPasswordOption,
    ): PasswordCredentialEntry = PasswordCredentialEntry.Builder(
        context,
        suggestion.username,
        getItemPendingIntent(suggestion.itemId),
        option,
    )
        .setDisplayName(suggestion.displayName)
        .setLastUsedTime(Instant.ofEpochMilli(suggestion.lastUsedAtMs))
        .build()

    /** One passkey entry, carrying only what the picker shows. */
    private fun passkeyEntry(
        suggestion: PasskeySuggestion,
        option: BeginGetPublicKeyCredentialOption,
    ): PublicKeyCredentialEntry = PublicKeyCredentialEntry.Builder(
        context,
        suggestion.username,
        getPasskeyPendingIntent(suggestion.itemId, suggestion.credentialId),
        option,
    )
        .setDisplayName(suggestion.displayName)
        .setLastUsedTime(Instant.ofEpochMilli(suggestion.lastUsedAtMs))
        .build()

    // ------------------------------------------------------------------
    // Pending intents
    //
    // FLAG_MUTABLE throughout: the framework writes the request into each intent
    // before it launches the activity. An immutable one arrives empty.
    // ------------------------------------------------------------------

    private fun activityPendingIntent(requestCode: Int, fill: Intent.() -> Unit): PendingIntent {
        val intent = Intent(context, GetCredentialsActivity::class.java).apply(fill)
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    fun getItemPendingIntent(itemId: String): PendingIntent =
        activityPendingIntent(itemId.hashCode()) {
            putExtra(BitteryCredentialProviderService.EXTRA_ITEM_ID, itemId)
            putExtra(
                BitteryCredentialProviderService.EXTRA_REQUEST_TYPE,
                BitteryCredentialProviderService.REQUEST_TYPE_GET,
            )
        }

    fun getPasskeyPendingIntent(itemId: String, credentialId: String): PendingIntent =
        activityPendingIntent("${itemId}_$credentialId".hashCode()) {
            putExtra(BitteryCredentialProviderService.EXTRA_ITEM_ID, itemId)
            putExtra(
                BitteryCredentialProviderService.EXTRA_PASSKEY_CREDENTIAL_ID,
                credentialId,
            )
            putExtra(
                BitteryCredentialProviderService.EXTRA_REQUEST_TYPE,
                BitteryCredentialProviderService.REQUEST_TYPE_GET_PASSKEY,
            )
        }

    fun unlockPendingIntent(): PendingIntent =
        activityPendingIntent(BitteryCredentialProviderService.REQUEST_TYPE_UNLOCK.hashCode()) {
            putExtra(
                BitteryCredentialProviderService.EXTRA_REQUEST_TYPE,
                BitteryCredentialProviderService.REQUEST_TYPE_UNLOCK,
            )
        }

    fun createPasskeyPendingIntent(requestJson: String): PendingIntent {
        val requestCode = "${BitteryCredentialProviderService.REQUEST_TYPE_CREATE_PASSKEY}:" +
            "${requestJson.hashCode()}"
        return activityPendingIntent(requestCode.hashCode()) {
            putExtra(
                BitteryCredentialProviderService.EXTRA_REQUEST_TYPE,
                BitteryCredentialProviderService.REQUEST_TYPE_CREATE_PASSKEY,
            )
        }
    }

    // ------------------------------------------------------------------
    // The calling app's origin
    // ------------------------------------------------------------------

    /** The allowlist that lets a browser speak for the site it is showing. */
    val allowlistJson: String by lazy {
        try {
            val resources = context.resources
            val resId = resources.getIdentifier(
                "credential_provider_allowlist",
                "raw",
                context.packageName,
            )
            if (resId == 0) {
                Log.w(tag, "Allowlist resource not found")
                "[]"
            } else {
                resources.openRawResource(resId).bufferedReader().use { it.readText() }
            }
        } catch (e: Exception) {
            Log.w(tag, "Failed to load allowlist JSON", e)
            "[]"
        }
    }

    /** The relying party an origin names, or nothing when it names no host. */
    fun passkeyRpIdFromOrigin(origin: String): String {
        if (!origin.startsWith("http")) return ""
        return PasskeyUtils.normalizeHost(origin)
    }

    fun resolveCallingOrigin(originJsonOrString: String?, packageName: String?): String {
        val origin = originList(originJsonOrString)
            .firstOrNull { it.isNotBlank() }
            ?.let { normalizeOrigin(it) }
        return origin ?: packageName.orEmpty()
    }

    private fun normalizeOrigin(origin: String): String {
        val trimmed = origin.trim()
        if (trimmed.isBlank()) return trimmed
        if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
            return trimmed
        }

        return try {
            val uri = java.net.URI(trimmed)
            val scheme = uri.scheme?.lowercase() ?: return trimmed.removeSuffix("/")
            val host = uri.host?.lowercase() ?: return trimmed.removeSuffix("/")
            val authorityHost = if (host.contains(":")) "[$host]" else host
            val port = uri.port
            val includePort = port != -1 &&
                !((scheme == "https" && port == 443) || (scheme == "http" && port == 80))

            buildString {
                append(scheme)
                append("://")
                append(authorityHost)
                if (includePort) {
                    append(':')
                    append(port)
                }
            }
        } catch (_: Exception) {
            trimmed.removeSuffix("/")
        }
    }

    private fun originList(originJsonOrString: String?): List<String> {
        if (originJsonOrString.isNullOrBlank()) return emptyList()

        val trimmed = originJsonOrString.trim()
        if (trimmed.startsWith("[")) {
            try {
                val array = JSONArray(trimmed)
                val results = ArrayList<String>(array.length())
                for (index in 0 until array.length()) {
                    val value = array.optString(index, "")
                    if (value.isNotBlank()) {
                        results.add(value)
                    }
                }
                if (results.isNotEmpty()) {
                    return results
                }
            } catch (e: Exception) {
                Log.w(tag, "Failed to parse origin JSON: $originJsonOrString", e)
            }
        }

        return listOf(originJsonOrString)
    }
}
