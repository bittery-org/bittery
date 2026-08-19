package com.bittery.mobile.credentialprovider.service

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
import androidx.credentials.provider.BeginCreatePublicKeyCredentialRequest
import androidx.credentials.provider.BeginGetCredentialRequest
import androidx.credentials.provider.BeginGetCredentialResponse
import androidx.credentials.provider.CreateEntry
import androidx.credentials.provider.CredentialProviderService
import androidx.credentials.provider.ProviderClearCredentialStateRequest
import com.bittery.mobile.credentialprovider.vault.NativeCredentialVaults
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Android Credential Provider Service for Bittery password manager.
 * Handles autofill requests from other apps.
 */
@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
class BitteryCredentialProviderService : CredentialProviderService() {

    companion object {
        private const val TAG = "BitteryCredProvider"
        const val EXTRA_ITEM_ID = "item_id"
        const val EXTRA_REQUEST_TYPE = "request_type"
        const val REQUEST_TYPE_GET = "get"
        const val REQUEST_TYPE_GET_PASSKEY = "get_passkey"
        const val REQUEST_TYPE_CREATE_PASSKEY = "create_passkey"
        const val REQUEST_TYPE_UNLOCK = "unlock"
        const val EXTRA_ORIGIN = "origin"
        const val EXTRA_USERNAME = "username"
        const val EXTRA_PASSWORD = "password"
        const val EXTRA_PASSKEY_CREDENTIAL_ID = "passkey_credential_id"
    }

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    /** The one vault this process has. It is shared with the app and the activities. */
    private val vault by lazy { NativeCredentialVaults.of(applicationContext) }

    /**
     * What a `BeginGetCredentialRequest` is answered with, shared with
     * [GetCredentialsActivity] so an unlock rebuilds the very same response.
     */
    private val responses by lazy { BeginGetCredentialResponses(applicationContext, TAG) }

    /**
     * Handle password autofill requests.
     * Called when an app requests credentials.
     *
     * Flow:
     * 1. Ask the vault whether any account holds a live key
     * 2. If locked: return AuthenticationAction to trigger unlock flow
     * 3. If unlocked: query credentials and return them
     */
    override fun onBeginGetCredentialRequest(
        request: BeginGetCredentialRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<BeginGetCredentialResponse, GetCredentialException>
    ) {
        Log.d(TAG, "========================================")
        Log.d(TAG, "onBeginGetCredentialRequest called!")
        Log.d(TAG, "CallingAppInfo: ${request.callingAppInfo}")
        val rawOrigin = try {
            request.callingAppInfo?.getOrigin(responses.allowlistJson)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to get origin (caller may not be in allowlist): ${e::class.simpleName}: ${e.message}")
            null
        }
        val callingOrigin = responses.resolveCallingOrigin(
            rawOrigin,
            request.callingAppInfo?.packageName,
        )
        Log.d(TAG, "CallingAppInfo.origin(raw): $rawOrigin")
        Log.d(TAG, "CallingAppInfo.origin(resolved): $callingOrigin")
        Log.d(TAG, "CallingAppInfo.packageName: ${request.callingAppInfo?.packageName}")
        Log.d(TAG, "Options count: ${request.beginGetCredentialOptions.size}")
        val optionTypes = request.beginGetCredentialOptions.map { it::class.simpleName }
        Log.d(TAG, "Option types: $optionTypes")
        Log.d(TAG, "========================================")

        serviceScope.launch {
            try {
                callback.onResult(responses.build(vault, request, callingOrigin))
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
				callback.onError(
					CreateCredentialUnknownException(
						"Password creation is not available through the credential provider"
					)
				)
            } else if (request is BeginCreatePublicKeyCredentialRequest) {
                val createEntry = CreateEntry.Builder(
                    "Bittery",
                    responses.createPasskeyPendingIntent(request.requestJson)
                )
                    .setDescription("Save passkey to Bittery")
                    .setPublicKeyCredentialCount(1)
                    .build()

                val response = BeginCreateCredentialResponse.Builder()
                    .setCreateEntries(listOf(createEntry))
                    .build()

                callback.onResult(response)
            } else {
                // Unknown credential type
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
}
