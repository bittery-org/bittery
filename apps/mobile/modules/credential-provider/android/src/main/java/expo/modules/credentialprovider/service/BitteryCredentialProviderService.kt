package expo.modules.credentialprovider.service

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.os.CancellationSignal
import android.os.OutcomeReceiver
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.CreateCredentialUnknownException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialUnknownException
import androidx.credentials.provider.BeginCreateCredentialRequest
import androidx.credentials.provider.BeginCreateCredentialResponse
import androidx.credentials.provider.BeginCreatePasswordCredentialRequest
import androidx.credentials.provider.BeginGetCredentialRequest
import androidx.credentials.provider.BeginGetCredentialResponse
import androidx.credentials.provider.BeginGetPasswordOption
import androidx.credentials.provider.CreateEntry
import androidx.credentials.provider.CredentialProviderService
import androidx.credentials.provider.PasswordCredentialEntry
import androidx.credentials.provider.ProviderClearCredentialStateRequest
import expo.modules.credentialprovider.activity.GetCredentialsActivity
import expo.modules.credentialprovider.storage.CredentialDatabase
import expo.modules.credentialprovider.storage.CredentialEntity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.time.Instant

/**
 * Android Credential Provider Service for Bittery password manager.
 * Handles autofill requests from other apps.
 */
@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
class BitteryCredentialProviderService : CredentialProviderService() {
    companion object {
        private const val TAG = "BitteryCredProvider"
        const val EXTRA_CREDENTIAL_ID = "credential_id"
        const val EXTRA_REQUEST_TYPE = "request_type"
        const val REQUEST_TYPE_GET = "get"
        const val REQUEST_TYPE_CREATE = "create"
        const val EXTRA_ORIGIN = "origin"
        const val EXTRA_USERNAME = "username"
        const val EXTRA_PASSWORD = "password"
    }

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private val database: CredentialDatabase by lazy {
        CredentialDatabase.getInstance(applicationContext)
    }

    /**
     * Handle password autofill requests.
     * Called when an app requests credentials.
     */
    override fun onBeginGetCredentialRequest(
        request: BeginGetCredentialRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<BeginGetCredentialResponse, GetCredentialException>
    ) {
        Log.d(TAG, "========================================")
        Log.d(TAG, "onBeginGetCredentialRequest called!")
        Log.d(TAG, "CallingAppInfo: ${request.callingAppInfo}")
        // Use getOrigin with empty JSON allowlist - Chrome will provide origin for web requests
        val callingOrigin = try {
            request.callingAppInfo?.getOrigin("[]")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to get origin", e)
            null
        } ?: request.callingAppInfo?.packageName
        Log.d(TAG, "CallingAppInfo.origin: $callingOrigin")
        Log.d(TAG, "CallingAppInfo.packageName: ${request.callingAppInfo?.packageName}")
        Log.d(TAG, "Options count: ${request.beginGetCredentialOptions.size}")
        Log.d(TAG, "========================================")

        serviceScope.launch {
            try {
                val credentialEntries = mutableListOf<PasswordCredentialEntry>()

                for (option in request.beginGetCredentialOptions) {
                    Log.d(TAG, "Processing option: ${option::class.simpleName}")
                    if (option is BeginGetPasswordOption) {
                        val origin = try {
                            request.callingAppInfo?.getOrigin("[]")
                        } catch (e: Exception) {
                            null
                        } ?: request.callingAppInfo?.packageName ?: ""

                        Log.d(TAG, "Password request for origin: $origin")

                        // Query credentials matching the origin/domain
                        val domain = extractDomain(origin)
                        Log.d(TAG, "Extracted domain: $domain")

                        // First, log all credentials in database
                        val allCredentials = database.credentialDao().getAll()
                        Log.d(TAG, "Total credentials in database: ${allCredentials.size}")
                        for (cred in allCredentials) {
                            Log.d(TAG, "  - DB credential: domain=${cred.domain}, username=${cred.username}")
                        }

                        val credentials = if (domain.isNotEmpty()) {
                            database.credentialDao().getByDomain(domain)
                        } else {
                            allCredentials
                        }

                        Log.d(TAG, "Found ${credentials.size} matching credentials for domain '$domain'")

                        for (credential in credentials) {
                            Log.d(TAG, "Creating entry for: ${credential.username} @ ${credential.domain}")
                            val entry = createPasswordEntry(credential, option)
                            credentialEntries.add(entry)
                        }
                    }
                }

                Log.d(TAG, "Returning ${credentialEntries.size} credential entries to system")
                val response = BeginGetCredentialResponse.Builder()
                    .setCredentialEntries(credentialEntries)
                    .build()

                callback.onResult(response)
                Log.d(TAG, "Response sent successfully")
            } catch (e: Exception) {
                Log.e(TAG, "Error in onBeginGetCredentialRequest", e)
                callback.onError(GetCredentialUnknownException("Failed to get credentials: ${e.message}"))
            }
        }
    }

    /**
     * Handle credential creation requests.
     * Called when an app wants to save a new credential.
     */
    override fun onBeginCreateCredentialRequest(
        request: BeginCreateCredentialRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<BeginCreateCredentialResponse, CreateCredentialException>
    ) {
        Log.d(TAG, "onBeginCreateCredentialRequest called")

        try {
            if (request is BeginCreatePasswordCredentialRequest) {
                val createEntry = CreateEntry.Builder(
                    "Bittery",
                    createCreatePendingIntent(request)
                )
                    .setDescription("Save password to Bittery")
                    .build()

                val response = BeginCreateCredentialResponse.Builder()
                    .setCreateEntries(listOf(createEntry))
                    .build()

                callback.onResult(response)
            } else {
                // We only support password credentials for now
                callback.onError(CreateCredentialUnknownException("Unsupported credential type"))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error in onBeginCreateCredentialRequest", e)
            callback.onError(CreateCredentialUnknownException("Failed to create credential: ${e.message}"))
        }
    }

    /**
     * Handle credential state clearing.
     */
    override fun onClearCredentialStateRequest(
        request: ProviderClearCredentialStateRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<Void?, ClearCredentialException>
    ) {
        Log.d(TAG, "onClearCredentialStateRequest called")
        // We don't store any session state, so just return success
        callback.onResult(null)
    }

    /**
     * Create a PasswordCredentialEntry for display in the credential picker.
     */
    private fun createPasswordEntry(
        credential: CredentialEntity,
        option: BeginGetPasswordOption
    ): PasswordCredentialEntry {
        val pendingIntent = createGetPendingIntent(credential.id)

        return PasswordCredentialEntry.Builder(
            applicationContext,
            credential.username,
            pendingIntent,
            option
        )
            .setDisplayName(credential.displayName)
            .setLastUsedTime(Instant.ofEpochMilli(credential.lastUsedAt))
            .build()
    }

    /**
     * Create PendingIntent for credential retrieval.
     * Opens GetCredentialsActivity for biometric authentication.
     */
    private fun createGetPendingIntent(credentialId: String): PendingIntent {
        val intent = Intent(applicationContext, GetCredentialsActivity::class.java).apply {
            putExtra(EXTRA_CREDENTIAL_ID, credentialId)
            putExtra(EXTRA_REQUEST_TYPE, REQUEST_TYPE_GET)
        }

        return PendingIntent.getActivity(
            applicationContext,
            credentialId.hashCode(),
            intent,
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
    }

    /**
     * Create PendingIntent for credential creation.
     * Opens activity to save a new credential.
     */
    private fun createCreatePendingIntent(request: BeginCreatePasswordCredentialRequest): PendingIntent {
        val intent = Intent(applicationContext, GetCredentialsActivity::class.java).apply {
            putExtra(EXTRA_REQUEST_TYPE, REQUEST_TYPE_CREATE)
            // The actual username/password will come from ProviderCreateCredentialRequest
        }

        return PendingIntent.getActivity(
            applicationContext,
            REQUEST_TYPE_CREATE.hashCode(),
            intent,
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
    }

    /**
     * Extract domain from origin URL or package name.
     */
    private fun extractDomain(origin: String): String {
        return try {
            if (origin.startsWith("http")) {
                // It's a URL, extract the host
                val url = java.net.URL(origin)
                url.host
            } else if (origin.startsWith("android:apk-key-hash:")) {
                // It's an Android app signature, extract package name from calling app
                ""
            } else {
                // Assume it's already a domain or package name
                origin.removePrefix("www.")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to extract domain from: $origin", e)
            ""
        }
    }
}
