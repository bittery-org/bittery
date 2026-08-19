package com.bittery.mobile.credentialprovider.activity

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PasswordCredential
import androidx.credentials.PublicKeyCredential
import androidx.credentials.provider.BeginGetCredentialResponse
import androidx.credentials.provider.PendingIntentHandler
import androidx.credentials.webauthn.AuthenticatorAssertionResponse
import androidx.credentials.webauthn.AuthenticatorAttestationResponse
import androidx.credentials.webauthn.FidoPublicKeyCredential
import androidx.credentials.webauthn.PublicKeyCredentialCreationOptions
import androidx.credentials.webauthn.PublicKeyCredentialRequestOptions
import androidx.fragment.app.FragmentActivity
import com.bittery.mobile.credentialprovider.passkey.CreateRequestContext
import com.bittery.mobile.credentialprovider.passkey.PasskeyUtils
import com.bittery.mobile.credentialprovider.service.BeginGetCredentialResponses
import com.bittery.mobile.credentialprovider.service.BitteryCredentialProviderService
import com.bittery.mobile.credentialprovider.vault.NativeCredentialVault
import com.bittery.mobile.credentialprovider.vault.NativeCredentialVaults
import com.bittery.mobile.credentialprovider.vault.PasskeyAssertionRequest
import com.bittery.mobile.credentialprovider.vault.PasskeyAssertionResult
import com.bittery.mobile.credentialprovider.vault.PasskeySaveCandidate
import com.bittery.mobile.credentialprovider.vault.PasskeySaveRequest
import com.bittery.mobile.credentialprovider.vault.PasskeySaveResult
import com.bittery.mobile.credentialprovider.vault.PasskeySaveTarget
import com.bittery.mobile.credentialprovider.vault.PasskeySaveTargetChoice
import com.bittery.mobile.credentialprovider.vault.PasswordReveal
import com.bittery.mobile.credentialprovider.vault.UnlockResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

/**
 * The screen behind every credential-provider entry.
 *
 * The system launches it by `PendingIntent` when the user picks one of Bittery's
 * entries, so it is the one place in the credential provider that can show
 * something: a biometric prompt, or a list to choose from.
 *
 * It owns the *framework* half of each request — reading the provider request,
 * building the WebAuthn response objects, setting the activity result — and asks
 * [NativeCredentialVault] for everything else. No key, no row and no cipher is
 * handled here.
 */
@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
class GetCredentialsActivity : FragmentActivity() {
    companion object {
        private const val TAG = "GetCredentialsActivity"

        /** The line under "Unlock Bittery" when this screen asks for biometrics. */
        private const val UNLOCK_SUBTITLE = "Authenticate to access your passwords"
    }

    private val activityScope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private lateinit var vault: NativeCredentialVault

    /** The same response builder the service uses. See [BeginGetCredentialResponses]. */
    private val responses by lazy { BeginGetCredentialResponses(applicationContext, TAG) }
    private val allowlistJson: String get() = responses.allowlistJson

    private var itemId: String? = null
    private var passkeyCredentialId: String? = null
    private var requestType: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        vault = NativeCredentialVaults.of(applicationContext)

        itemId = intent.getStringExtra(BitteryCredentialProviderService.EXTRA_ITEM_ID)
        passkeyCredentialId =
            intent.getStringExtra(BitteryCredentialProviderService.EXTRA_PASSKEY_CREDENTIAL_ID)
        requestType = intent.getStringExtra(BitteryCredentialProviderService.EXTRA_REQUEST_TYPE)

        Log.d(
            TAG,
            "Activity started - requestType: $requestType, itemId: $itemId, " +
                "passkeyCredentialId: $passkeyCredentialId, pid=${android.os.Process.myPid()}"
        )

        unlockIfNeededThenDispatch()
    }

    /**
     * The cold-start gate.
     *
     * The live keys are in memory only, so a service started cold has none. This
     * activity is the one place that can ask: it can show a `BiometricPrompt` and
     * unwrap the escrowed key. Without a usable escrow it hands the user to the
     * app for a master-password unlock. Neither path answers "no credentials".
     */
    private fun unlockIfNeededThenDispatch() {
        if (vault.unlockedAccountIds().isNotEmpty()) {
            dispatchRequest()
            return
        }

        val state = vault.biometricUnlockState()
        if (!state.canUnlock) {
            Log.d(
                TAG,
                "No usable escrow - launching the app " +
                    "(passwordRequired=${state.masterPasswordRequired})"
            )
            launchAppForPasswordUnlock(passwordRequired = state.masterPasswordRequired)
            return
        }

        activityScope.launch { unlockThen { dispatchRequest() } }
    }

    private fun dispatchRequest() {
        when (requestType) {
            BitteryCredentialProviderService.REQUEST_TYPE_GET -> {
                if (itemId != null) {
                    handleGetItemCredential()
                } else {
                    finishWithError("No item ID provided")
                }
            }
            BitteryCredentialProviderService.REQUEST_TYPE_GET_PASSKEY -> handleGetPasskeyCredential()
            BitteryCredentialProviderService.REQUEST_TYPE_CREATE_PASSKEY -> handleCreatePasskeyCredential()
            BitteryCredentialProviderService.REQUEST_TYPE_UNLOCK -> handleUnlock()
            else -> {
                Log.e(TAG, "Unknown request type: $requestType")
                finishWithError("Unknown request type")
            }
        }
    }

    /**
     * Prompt for biometrics, then carry on.
     *
     * This is the only way a locked vault comes back inside the credential
     * provider. The vault decides whether the escrow may be used and does the
     * unwrapping; this only turns a refusal into a cancelled request.
     */
    private suspend fun unlockThen(onUnlocked: suspend () -> Unit) {
        when (val result = vault.unlockWithBiometric(this, UNLOCK_SUBTITLE)) {
            is UnlockResult.Unlocked -> onUnlocked()

            UnlockResult.NoEscrow ->
                launchAppForPasswordUnlock(passwordRequired = false)

            // A pre-rekey record. Re-enrolment needs the master password.
            UnlockResult.NeedsReenrolment ->
                launchAppForPasswordUnlock(passwordRequired = true)

            is UnlockResult.Rejected -> finishWithError("Authentication error: ${result.message}")

            is UnlockResult.PromptUnavailable -> finishWithError(result.message)

            is UnlockResult.PromptFailed -> finishWithError(result.message)

            is UnlockResult.Failed -> finishWithError("Failed to unlock: ${result.message}")
        }
    }

    /**
     * The plain unlock request, behind the "Unlock Bittery" entry.
     *
     * An `AuthenticationAction` is not finished by a bare `RESULT_OK`. The framework
     * asked a question and wants the *answer*: a fresh `BeginGetCredentialResponse`
     * built now that the vault is open. Returning nothing leaves the picker with the
     * locked response it already had, which is an unlocked vault showing no
     * suggestions.
     */
    private fun handleUnlock() {
        if (vault.unlockedAccountIds().isEmpty()) {
            Log.w(TAG, "Unlock request could not be served here - launching the app")
            launchAppForPasswordUnlock(
                passwordRequired = vault.biometricUnlockState().masterPasswordRequired,
            )
            return
        }

        val beginRequest = PendingIntentHandler.retrieveBeginGetCredentialRequest(intent)
        if (beginRequest == null) {
            // Nothing to answer. The unlock itself still happened and stands.
            Log.w(TAG, "Unlocked, but this intent carries no begin-get request")
            setResult(Activity.RESULT_OK)
            finish()
            return
        }

        activityScope.launch {
            try {
                val rawOrigin = try {
                    beginRequest.callingAppInfo?.getOrigin(allowlistJson)
                } catch (_: Exception) {
                    null
                }
                val callingOrigin = responses.resolveCallingOrigin(
                    rawOrigin,
                    beginRequest.callingAppInfo?.packageName,
                )

                val response: BeginGetCredentialResponse =
                    responses.build(vault, beginRequest, callingOrigin)

                val resultIntent = Intent()
                PendingIntentHandler.setBeginGetCredentialResponse(resultIntent, response)
                setResult(Activity.RESULT_OK, resultIntent)
                Log.d(TAG, "Unlocked - returned a rebuilt begin-get response")
                finish()
            } catch (e: Exception) {
                Log.e(TAG, "Failed to rebuild the response after unlock", e)
                finishWithError("Failed to build credentials: ${e.message}")
            }
        }
    }

    // ------------------------------------------------------------------
    // Passwords
    // ------------------------------------------------------------------

    /** Hand back the password of the item the user picked. */
    private fun handleGetItemCredential() {
        val iId = itemId
        if (iId == null) {
            finishWithError("No item ID provided")
            return
        }

        activityScope.launch {
            try {
                when (val reveal = vault.revealPassword(iId)) {
                    is PasswordReveal.Revealed -> completeGetItemCredential(reveal)

                    PasswordReveal.ItemNotFound -> finishWithError("Item not found")

                    is PasswordReveal.Failed -> finishWithError(reveal.reason)

                    is PasswordReveal.Locked -> {
                        if (reveal.canUnlockWithBiometric) {
                            Log.w(TAG, "No live key for this item's account - trying escrow")
                            unlockThen {
                                val again = vault.revealPassword(iId)
                                if (again is PasswordReveal.Revealed) {
                                    completeGetItemCredential(again)
                                } else {
                                    finishWithError("Item not found")
                                }
                            }
                        } else {
                            Log.w(TAG, "No escrow for this item's account - launching the app")
                            launchAppForPasswordUnlock(passwordRequired = false)
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error preparing item credential retrieval", e)
                finishWithError("Failed to prepare authentication: ${e.message}")
            }
        }
    }

    private fun completeGetItemCredential(reveal: PasswordReveal.Revealed) {
        // The framework only accepts an answer to the request it started.
        if (PendingIntentHandler.retrieveProviderGetCredentialRequest(intent) == null) {
            finishWithError("Credential provider request is missing")
            return
        }

        val response = GetCredentialResponse(
            PasswordCredential(id = reveal.username, password = reveal.password),
        )
        val resultIntent = Intent()
        PendingIntentHandler.setGetCredentialResponse(resultIntent, response)
        setResult(Activity.RESULT_OK, resultIntent)
        finish()
    }

    // ------------------------------------------------------------------
    // Passkey assertion
    // ------------------------------------------------------------------

    /** Sign an assertion with the passkey the user picked. */
    private fun handleGetPasskeyCredential() {
        val iId = itemId
        val selectedCredentialId = passkeyCredentialId
        if (iId == null || selectedCredentialId.isNullOrBlank()) {
            finishWithError("Missing passkey selection context")
            return
        }

        activityScope.launch {
            try {
                val providerGetRequest =
                    PendingIntentHandler.retrieveProviderGetCredentialRequest(intent)
                        ?: return@launch finishWithError("No provider get request found")

                val passkeyOption = providerGetRequest.credentialOptions
                    .firstOrNull { it is GetPublicKeyCredentialOption } as? GetPublicKeyCredentialOption
                    ?: return@launch finishWithError("No public key credential option found")

                val rawOrigin = try {
                    providerGetRequest.callingAppInfo?.getOrigin(allowlistJson)
                } catch (_: Exception) {
                    null
                }
                val origin = responses.resolveCallingOrigin(
                    rawOrigin,
                    providerGetRequest.callingAppInfo?.packageName,
                )

                val rpId = PasskeyUtils.parseRpIdFromGetRequestJson(passkeyOption.requestJson)
                    ?.takeIf { it.isNotBlank() }
                    ?: responses.passkeyRpIdFromOrigin(origin).takeIf { it.isNotBlank() }
                    ?: return@launch finishWithError("Missing rpId in get request")

                val clientDataHash = passkeyOption.clientDataHash
                if (clientDataHash == null || clientDataHash.isEmpty()) {
                    return@launch finishWithError("Missing clientDataHash for assertion")
                }

                val assertion = vault.assertPasskey(
                    PasskeyAssertionRequest(
                        itemId = iId,
                        credentialId = selectedCredentialId,
                        rpId = rpId,
                        clientDataHashBase64 = PasskeyUtils.encodeBase64(clientDataHash),
                    ),
                )

                when (assertion) {
                    is PasskeyAssertionResult.Signed -> completeGetPasskeyCredential(
                        assertion = assertion,
                        requestJson = passkeyOption.requestJson,
                        origin = origin,
                        packageName = providerGetRequest.callingAppInfo?.packageName ?: "",
                        clientDataHash = clientDataHash,
                    )

                    PasskeyAssertionResult.ItemNotFound -> finishWithError("Item not found")

                    PasskeyAssertionResult.Locked -> {
                        Log.w(TAG, "No live key for this passkey's account - launching the app")
                        launchAppForPasswordUnlock(passwordRequired = false)
                    }

                    is PasskeyAssertionResult.Failed ->
                        finishWithError("Failed to complete passkey assertion: ${assertion.reason}")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error preparing passkey assertion", e)
                finishWithError("Failed to prepare passkey assertion: ${e.message}")
            }
        }
    }

    private fun completeGetPasskeyCredential(
        assertion: PasskeyAssertionResult.Signed,
        requestJson: String,
        origin: String,
        packageName: String,
        clientDataHash: ByteArray,
    ) {
        val assertionResponse = AuthenticatorAssertionResponse(
            PublicKeyCredentialRequestOptions(requestJson),
            assertion.credentialIdBytes,
            origin,
            true,
            true,
            true,
            true,
            assertion.userHandle,
            packageName,
            clientDataHash
        ).apply {
            this.authenticatorData = assertion.authenticatorData
            this.signature = assertion.signature
        }

        val fidoCredential = FidoPublicKeyCredential(
            assertion.credentialIdBytes,
            assertionResponse,
            "platform"
        )

        val resultIntent = Intent()
        PendingIntentHandler.setGetCredentialResponse(
            resultIntent,
            GetCredentialResponse(PublicKeyCredential(fidoCredential.json())),
        )
        setResult(Activity.RESULT_OK, resultIntent)
        finish()
    }

    // ------------------------------------------------------------------
    // Passkey registration
    // ------------------------------------------------------------------

    private fun handleCreatePasskeyCredential() {
        activityScope.launch {
            try {
                val createRequest = PendingIntentHandler.retrieveProviderCreateCredentialRequest(intent)
                    ?: return@launch finishWithError("No create request found")

                val callingRequest = createRequest.callingRequest as? CreatePublicKeyCredentialRequest
                    ?: return@launch finishWithError("Not a passkey create request")

                val context = PasskeyUtils.parseCreateRequestContext(callingRequest.requestJson)
                    ?: return@launch finishWithError("Invalid passkey creation payload")

                val target = when (
                    val choice = vault.passkeySaveTarget(context.rpId, context.userName)
                ) {
                    is PasskeySaveTargetChoice.Resolved -> choice.target

                    is PasskeySaveTargetChoice.Ambiguous -> askWhereToSave(choice.candidates)
                        ?: return@launch finishWithError("Passkey save target selection cancelled")

                    PasskeySaveTargetChoice.VaultLocked -> {
                        Log.w(TAG, "No unlocked account available for passkey create")
                        return@launch launchAppForPasswordUnlock(passwordRequired = false)
                    }

                    PasskeySaveTargetChoice.LockedAccountOwnsMatch -> {
                        Log.w(TAG, "A matching item exists, but its account is locked")
                        return@launch launchAppForPasswordUnlock(passwordRequired = false)
                    }
                }

                val saved = vault.savePasskey(
                    PasskeySaveRequest(
                        target = target,
                        rpId = context.rpId,
                        rpName = context.rpName,
                        userHandle = context.userHandle,
                        userName = context.userName,
                        userDisplayName = context.userDisplayName,
                    ),
                )

                when (saved) {
                    is PasskeySaveResult.Saved -> completeCreatePasskeyCredential(
                        saved = saved,
                        callingRequestJson = callingRequest.requestJson,
                        origin = responses.resolveCallingOrigin(
                            try {
                                createRequest.callingAppInfo?.getOrigin(allowlistJson)
                            } catch (_: Exception) {
                                null
                            },
                            createRequest.callingAppInfo?.packageName,
                        ),
                        context = context,
                    )

                    is PasskeySaveResult.Failed ->
                        finishWithError("Failed to prepare passkey creation: ${saved.reason}")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error preparing passkey creation", e)
                finishWithError("Failed to prepare passkey creation: ${e.message}")
            }
        }
    }

    /** The only question this screen asks with a list: which login holds the passkey. */
    private suspend fun askWhereToSave(
        candidates: List<PasskeySaveCandidate>,
    ): PasskeySaveTarget? = suspendCoroutine { continuation ->
        val labels = candidates.map { candidate ->
            "${candidate.label} (${candidate.username ?: "Unknown account"})"
        }.toMutableList()
        labels.add("Create new login item")

        AlertDialog.Builder(this)
            .setTitle("Save passkey to")
            .setItems(labels.toTypedArray()) { _, which ->
                if (which == labels.lastIndex) {
                    continuation.resume(PasskeySaveTarget.NewItem)
                } else {
                    continuation.resume(
                        PasskeySaveTarget.ExistingItem(candidates[which].itemId),
                    )
                }
            }
            .setOnCancelListener { continuation.resume(null) }
            .create()
            .show()
    }

    private fun completeCreatePasskeyCredential(
        saved: PasskeySaveResult.Saved,
        callingRequestJson: String,
        origin: String,
        context: CreateRequestContext,
    ) {
        val attestationResponse = AuthenticatorAttestationResponse(
            PublicKeyCredentialCreationOptions(callingRequestJson),
            saved.credentialIdBytes,
            saved.publicKeyCose,
            origin,
            true,
            true,
            true,
            true,
            null,
            null
        ).apply {
            this.attestationObject = saved.attestationObject
        }

        val fidoCredential = FidoPublicKeyCredential(
            saved.credentialIdBytes,
            attestationResponse,
            "platform"
        )
        val registrationJson = JSONObject(fidoCredential.json())
        val responseJson = registrationJson.optJSONObject("response")
            ?: JSONObject().also { registrationJson.put("response", it) }
        // Chromium's CredMan bridge requires this field to deserialize create responses.
        responseJson.put("publicKeyAlgorithm", -7)
        responseJson.put("authenticatorData", PasskeyUtils.encodeBase64Url(saved.authenticatorData))
        responseJson.put("publicKey", PasskeyUtils.encodeBase64Url(saved.publicKeySpki))

        Log.d(TAG, "Passkey registration response built (rpId=${context.rpId}, origin=$origin)")

        val resultIntent = Intent()
        PendingIntentHandler.setCreateCredentialResponse(
            resultIntent,
            CreatePublicKeyCredentialResponse(registrationJson.toString()),
        )
        setResult(Activity.RESULT_OK, resultIntent)
        Log.d(TAG, "Passkey created and stored on item ${saved.itemId}")
        finish()
    }

    /**
     * Launch the main Bittery app for password unlock.
     *
     * @param passwordRequired true if master password re-entry is required (30 days),
     *                         false for regular unlock
     */
    private fun launchAppForPasswordUnlock(passwordRequired: Boolean) {
        try {
            val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
            if (launchIntent == null) {
                Log.e(TAG, "Could not get launch intent for app")
                finishWithError("Failed to open Bittery app")
                return
            }

            // Come back to autofill after the unlock.
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            launchIntent.putExtra("autofill_unlock", true)
            launchIntent.putExtra("password_required", passwordRequired)
            launchIntent.data = android.net.Uri.parse(
                "bittery://autofill-unlock?passwordRequired=$passwordRequired"
            )

            Log.d(TAG, "Launching app for password unlock (passwordRequired=$passwordRequired)")
            startActivity(launchIntent)

            setResult(Activity.RESULT_CANCELED)
            finish()
        } catch (e: Exception) {
            Log.e(TAG, "Error launching app for password unlock", e)
            finishWithError("Failed to open Bittery app: ${e.message}")
        }
    }

    private fun finishWithError(message: String) {
        Log.e(TAG, "Finishing with error: $message")
        setResult(Activity.RESULT_CANCELED)
        finish()
    }
}
