package expo.modules.credentialprovider.activity

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PasswordCredential
import androidx.credentials.PublicKeyCredential
import androidx.credentials.provider.PendingIntentHandler
import androidx.credentials.provider.ProviderCreateCredentialRequest
import androidx.credentials.provider.ProviderGetCredentialRequest
import androidx.credentials.webauthn.AuthenticatorAssertionResponse
import androidx.credentials.webauthn.AuthenticatorAttestationResponse
import androidx.credentials.webauthn.FidoPublicKeyCredential
import androidx.credentials.webauthn.PublicKeyCredentialCreationOptions
import androidx.credentials.webauthn.PublicKeyCredentialRequestOptions
import androidx.fragment.app.FragmentActivity
import expo.modules.credentialprovider.crypto.MukEscrowManager
import expo.modules.credentialprovider.crypto.NativeCrypto
import expo.modules.credentialprovider.crypto.VaultDecryptor
import expo.modules.credentialprovider.domain.DomainMatch
import expo.modules.credentialprovider.passkey.CreateRequestContext
import expo.modules.credentialprovider.passkey.PasskeyUtils
import expo.modules.credentialprovider.passkey.StoredPasskey
import expo.modules.credentialprovider.service.BitteryCredentialProviderService
import expo.modules.credentialprovider.state.VaultStateManager
import expo.modules.credentialprovider.storage.CredentialDatabase
import expo.modules.credentialprovider.storage.ItemDomainEntity
import expo.modules.credentialprovider.storage.PendingPasskeyMutationEntity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

/**
 * Activity for credential selection and biometric authentication.
 * This is launched via PendingIntent from the CredentialProviderService.
 */
@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
class GetCredentialsActivity : FragmentActivity() {
    companion object {
        private const val TAG = "GetCredentialsActivity"
    }

    private fun computeNextSignCount(currentCount: Int): Int {
        val nowSeconds = (System.currentTimeMillis() / 1000L) + 1L
        val fromStored = currentCount.toLong() + 1L
        val next = maxOf(fromStored, nowSeconds)
        return next.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
    }

    private sealed class PasskeyCreateTarget {
        data class ExistingItem(
            val item: expo.modules.credentialprovider.storage.ItemEntity
        ) : PasskeyCreateTarget()

        object CreateNewItem : PasskeyCreateTarget()
    }

    private val activityScope = CoroutineScope(Dispatchers.Main + SupervisorJob())
	private lateinit var database: CredentialDatabase
	private lateinit var mukEscrowManager: MukEscrowManager
    private val allowlistJson: String by lazy {
        loadAllowlistJson()
    }

	private var itemId: String? = null
    private var passkeyCredentialId: String? = null
    private var requestType: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        VaultStateManager.initialize(applicationContext)

		database = CredentialDatabase.getInstance(applicationContext)
        mukEscrowManager = MukEscrowManager(applicationContext)

		itemId = intent.getStringExtra(BitteryCredentialProviderService.EXTRA_ITEM_ID)
        passkeyCredentialId = intent.getStringExtra(BitteryCredentialProviderService.EXTRA_PASSKEY_CREDENTIAL_ID)
        requestType = intent.getStringExtra(BitteryCredentialProviderService.EXTRA_REQUEST_TYPE)

        Log.d(
            TAG,
			"Activity started - requestType: $requestType, itemId: $itemId, passkeyCredentialId: $passkeyCredentialId, pid=${android.os.Process.myPid()}"
        )
        VaultStateManager.dumpDebugState("GetCredentialsActivity.onCreate")
        Log.d(TAG, "MUK Escrow state: hasValidEscrow=${mukEscrowManager.hasValidEscrow()}, canUseBiometricUnlock=${mukEscrowManager.canUseBiometricUnlock()}, escrowUserId=${mukEscrowManager.getEscrowUserId()}")

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
     * Handle unified storage credential retrieval (uses VaultStateManager MUK).
     * The item is decrypted using the MUK from VaultStateManager.
     */
    private fun handleGetItemCredential() {
        val iId = itemId
        if (iId == null) {
            finishWithError("No item ID provided")
            return
        }

        activityScope.launch {
            try {
                // Load item to determine user context
                val item = withContext(Dispatchers.IO) {
                    database.itemDao().getById(iId)
                }

                if (item == null) {
                    finishWithError("Item not found")
                    return@launch
                }

                val muk = VaultStateManager.getMasterUnlockKey(item.userId)
                if (muk == null) {
                    Log.w(TAG, "MUK not available for user ${item.userId}, need to unlock first")
                    VaultStateManager.dumpDebugState("handleGetItemCredential MUK=null")
                    val escrowUserId = mukEscrowManager.getEscrowUserId()
                    val hasEscrow = mukEscrowManager.hasValidEscrow()
                    val canBiometric = mukEscrowManager.canUseBiometricUnlock()
                    Log.d(TAG, "Escrow state: hasValidEscrow=$hasEscrow, canBiometricUnlock=$canBiometric, escrowUserId=$escrowUserId, itemUserId=${item.userId}")
                    if (hasEscrow && (escrowUserId == null || escrowUserId == item.userId)) {
                        Log.d(TAG, "Attempting escrow unlock for item $iId")
                        handleUnlockWithEscrow(iId, escrowUserId ?: item.userId)
                    } else {
                        Log.w(TAG, "No valid escrow for user (hasEscrow=$hasEscrow, escrowUserId=$escrowUserId vs itemUserId=${item.userId}), launching app for password unlock")
                        launchAppForPasswordUnlock(passwordRequired = false)
                    }
                    return@launch
                }

                completeGetItemCredential(item, muk)
            } catch (e: Exception) {
                Log.e(TAG, "Error preparing item credential retrieval", e)
                finishWithError("Failed to prepare authentication: ${e.message}")
            }
        }
    }

    /**
     * Handle passkey assertion retrieval for a pre-selected item + credential ID.
     */
    private fun handleGetPasskeyCredential() {
        val iId = itemId
        val selectedCredentialId = passkeyCredentialId
        if (iId == null || selectedCredentialId.isNullOrBlank()) {
            finishWithError("Missing passkey selection context")
            return
        }

        activityScope.launch {
            try {
                val item = withContext(Dispatchers.IO) {
                    database.itemDao().getById(iId)
                }

                if (item == null) {
                    finishWithError("Item not found")
                    return@launch
                }

                val muk = VaultStateManager.getMasterUnlockKey(item.userId)
                if (muk == null) {
                    Log.w(TAG, "MUK not available for passkey get (userId=${item.userId})")
                    VaultStateManager.dumpDebugState("handleGetPasskeyCredential MUK=null")
                    launchAppForPasswordUnlock(passwordRequired = false)
                    return@launch
                }

                completeGetPasskeyCredential(item, muk, selectedCredentialId)
            } catch (e: Exception) {
                Log.e(TAG, "Error preparing passkey assertion", e)
                finishWithError("Failed to prepare passkey assertion: ${e.message}")
            }
        }
    }

    /**
     * Handle passkey creation request.
     */
    private fun handleCreatePasskeyCredential() {
        activityScope.launch {
            try {
                val createRequest = PendingIntentHandler.retrieveProviderCreateCredentialRequest(intent)
                if (createRequest == null) {
                    finishWithError("No create request found")
                    return@launch
                }

                val callingRequest = createRequest.callingRequest as? CreatePublicKeyCredentialRequest
                if (callingRequest == null) {
                    finishWithError("Not a passkey create request")
                    return@launch
                }

                try {
                    val source = JSONObject(callingRequest.requestJson).optJSONObject("publicKey")
                        ?: JSONObject(callingRequest.requestJson)
                    val requestedRpId = source.optJSONObject("rp")?.optString("id")
                        ?: source.optString("rpId")
                    val excludeCount = source.optJSONArray("excludeCredentials")?.length() ?: 0
                    Log.d(
                        TAG,
                        "Passkey create request parsed (rpId=$requestedRpId, excludeCredentials=$excludeCount)"
                    )
                } catch (_: Exception) {
                    Log.w(TAG, "Failed to parse raw passkey create request JSON")
                }

                val context = PasskeyUtils.parseCreateRequestContext(callingRequest.requestJson)
                if (context == null) {
                    finishWithError("Invalid passkey creation payload")
                    return@launch
                }

                val unlockedUserIds = VaultStateManager.getUnlockedUserIds()
                Log.d(TAG, "Passkey create unlockedUserIds=$unlockedUserIds")
                if (unlockedUserIds.isEmpty()) {
                    Log.w(TAG, "No unlocked user available for passkey create")
                    launchAppForPasswordUnlock(passwordRequired = false)
                    return@launch
                }

                val candidates = withContext(Dispatchers.IO) {
                    loadPasskeyCreateCandidates(
                        userIds = unlockedUserIds,
                        rpId = context.rpId,
                        requestedUserName = context.userName
                    )
                }
                val resolvedCandidates = if (candidates.isEmpty()) {
                    val decryptedFallbackCandidates = withContext(Dispatchers.IO) {
                        loadPasskeyCreateCandidatesByDecryptingItems(
                            userIds = unlockedUserIds,
                            rpId = context.rpId,
                            requestedUserName = context.userName
                        )
                    }
                    if (decryptedFallbackCandidates.isNotEmpty()) {
                        Log.d(
                            TAG,
                            "Passkey create decrypted fallback candidates found (count=${decryptedFallbackCandidates.size}, itemIds=${decryptedFallbackCandidates.map { it.id }})"
                        )
                    }
                    decryptedFallbackCandidates
                } else {
                    candidates
                }
                Log.d(
                    TAG,
                    "Passkey create candidates (rpId=${context.rpId}, user=${context.userName}, count=${resolvedCandidates.size}, itemIds=${resolvedCandidates.map { it.id }})"
                )

                if (resolvedCandidates.isEmpty()) {
                    val allUserCandidates = withContext(Dispatchers.IO) {
                        loadPasskeyCreateCandidatesAnyUser(
                            rpId = context.rpId,
                            requestedUserName = context.userName
                        )
                    }
                    if (allUserCandidates.isNotEmpty()) {
                        val lockedUserIds = allUserCandidates.map { it.userId }.distinct()
                        Log.w(
                            TAG,
                            "Found matching passkey target in local DB but user is not unlocked. lockedUserIds=$lockedUserIds, itemIds=${allUserCandidates.map { it.id }}"
                        )
                        launchAppForPasswordUnlock(passwordRequired = false)
                        return@launch
                    }
                }

                val target = resolvePasskeyCreateTarget(resolvedCandidates, context.userName)
                if (target == null) {
                    finishWithError("Passkey save target selection cancelled")
                    return@launch
                }

                completeCreatePasskeyCredential(
                    createRequest = createRequest,
                    callingRequest = callingRequest,
                    context = context,
                    target = target,
                    fallbackUserId = unlockedUserIds.first()
                )
            } catch (e: Exception) {
                Log.e(TAG, "Error preparing passkey creation", e)
                finishWithError("Failed to prepare passkey creation: ${e.message}")
            }
        }
    }

    /**
     * Try to unlock using escrowed MUK.
     */
    private fun handleUnlockWithEscrow(pendingItemId: String?, userId: String) {
        activityScope.launch {
            try {
                val cipher = mukEscrowManager.getDecryptCipher()

                withContext(Dispatchers.Main) {
                    val escrowPromptInfo = BiometricPrompt.PromptInfo.Builder()
                        .setTitle("Unlock Bittery")
                        .setSubtitle("Authenticate to access your passwords")
                        .setAllowedAuthenticators(
                            BiometricManager.Authenticators.BIOMETRIC_STRONG or
                            BiometricManager.Authenticators.DEVICE_CREDENTIAL
                        )
                        .build()

                    val escrowCallback = object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                            result.cryptoObject?.cipher?.let { authenticatedCipher ->
                                activityScope.launch {
                                    try {
                                        val muk = mukEscrowManager.retrieveEscrowedMuk(authenticatedCipher)
                                        VaultStateManager.setMasterUnlockKey(userId, muk)
                                        Log.d(TAG, "Successfully retrieved escrowed MUK for userId=$userId")
                                        VaultStateManager.dumpDebugState("AFTER escrow unlock")

                                        // If we have a pending item, complete the retrieval
                                        if (pendingItemId != null) {
                                            val item = withContext(Dispatchers.IO) {
                                                database.itemDao().getById(pendingItemId)
                                            }
                                            if (item != null) {
                                                completeGetItemCredential(item, muk)
                                            } else {
                                                finishWithError("Item not found")
                                            }
                                        } else {
                                            // Just unlock was requested
                                            setResult(Activity.RESULT_OK)
                                            finish()
                                        }
                                    } catch (e: Exception) {
                                        Log.e(TAG, "Failed to retrieve escrowed MUK", e)
                                        finishWithError("Failed to unlock: ${e.message}")
                                    }
                                }
                            } ?: finishWithError("No cipher after authentication")
                        }

                        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                            finishWithError("Authentication error: $errString")
                        }

                        override fun onAuthenticationFailed() {
                            // Let user retry
                        }
                    }

                    BiometricPrompt(this@GetCredentialsActivity, ContextCompat.getMainExecutor(this@GetCredentialsActivity), escrowCallback)
                        .authenticate(escrowPromptInfo, BiometricPrompt.CryptoObject(cipher))
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error preparing escrow unlock", e)
                finishWithError("Failed to prepare unlock: ${e.message}")
            }
        }
    }

    /**
     * Handle unlock request (no specific credential, just unlock the vault).
     */
    private fun handleUnlock() {
        Log.d(TAG, "handleUnlock: Starting unlock flow")
        VaultStateManager.dumpDebugState("handleUnlock")

        // Check 30-day master password requirement
        val masterPwRequired = mukEscrowManager.isMasterPasswordReentryRequired()
        Log.d(TAG, "handleUnlock: masterPasswordReentryRequired=$masterPwRequired")
        if (masterPwRequired) {
            Log.d(TAG, "30-day master password re-entry required")
            launchAppForPasswordUnlock(passwordRequired = true)
            return
        }

        // Check if we can use escrowed MUK
        val canBiometric = mukEscrowManager.canUseBiometricUnlock()
        val hasEscrow = mukEscrowManager.hasValidEscrow()
        val escrowUserId = mukEscrowManager.getEscrowUserId()
        Log.d(TAG, "handleUnlock: canBiometricUnlock=$canBiometric, hasValidEscrow=$hasEscrow, escrowUserId=$escrowUserId")

        if (canBiometric) {
            val userId = escrowUserId ?: "default"
            Log.d(TAG, "handleUnlock: Using escrow unlock for userId=$userId")
            handleUnlockWithEscrow(null, userId)
        } else {
            // Need to launch main app for full unlock
            Log.w(TAG, "handleUnlock: No valid escrow (hasEscrow=$hasEscrow, canBiometric=$canBiometric), need full password unlock")
            launchAppForPasswordUnlock(passwordRequired = false)
        }
    }

    /**
     * Complete item credential retrieval using the provided MUK.
     */
    private fun completeGetItemCredential(item: expo.modules.credentialprovider.storage.ItemEntity, muk: ByteArray) {
        activityScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    // Get the vault key for this item
                    val vaultKey = database.vaultKeyDao().getByVaultId(item.vaultId, item.userId)
                    if (vaultKey == null) {
                        withContext(Dispatchers.Main) {
                            finishWithError("Vault key not found")
                        }
                        return@withContext
                    }

                    // Decrypt the vault key using MUK
                    val decryptedVaultKey = VaultDecryptor.decryptVaultKeyWithMuk(vaultKey, muk)

                    // Decrypt the item to get the password
                    val decryptedItem = VaultDecryptor.decryptLoginItem(item, decryptedVaultKey)
                    val password = decryptedItem.password

                    if (password == null) {
                        withContext(Dispatchers.Main) {
                            finishWithError("No password found in item")
                        }
                        return@withContext
                    }

                    // Update last used timestamp
                    database.itemDao().updateLastUsed(item.id, System.currentTimeMillis())

                    Log.d(TAG, "Successfully decrypted item credential for ${decryptedItem.username}")

                    // Create the password credential response
                    val passwordCredential = PasswordCredential(
                        id = decryptedItem.username ?: item.username ?: "",
                        password = password
                    )

                    withContext(Dispatchers.Main) {
                        // Get the original request to build proper response
                        val getRequest = PendingIntentHandler.retrieveProviderGetCredentialRequest(intent)
                        if (getRequest != null) {
                            val response = GetCredentialResponse(passwordCredential)
                            val resultIntent = Intent()
                            PendingIntentHandler.setGetCredentialResponse(resultIntent, response)
                            setResult(Activity.RESULT_OK, resultIntent)
                        } else {
                            finishWithError("Credential provider request is missing")
                            return@withContext
                        }
                        finish()
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error completing item credential retrieval", e)
                withContext(Dispatchers.Main) {
                    finishWithError("Failed to retrieve credential: ${e.message}")
                }
            }
        }
    }

    /**
     * Complete passkey assertion response generation.
     */
    private fun completeGetPasskeyCredential(
        item: expo.modules.credentialprovider.storage.ItemEntity,
        muk: ByteArray,
        selectedCredentialId: String
    ) {
        activityScope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    val providerGetRequest = PendingIntentHandler.retrieveProviderGetCredentialRequest(intent)
                        ?: throw IllegalStateException("No provider get request found")

                    val passkeyOption = providerGetRequest.credentialOptions
                        .firstOrNull { it is GetPublicKeyCredentialOption } as? GetPublicKeyCredentialOption
                        ?: throw IllegalStateException("No public key credential option found")

                    val normalizedCredentialId = PasskeyUtils.canonicalizeCredentialId(selectedCredentialId)
                        ?: throw IllegalStateException("Invalid selected credential ID")

                    val rawOrigin = try {
                        providerGetRequest.callingAppInfo?.getOrigin(allowlistJson)
                    } catch (_: Exception) {
                        null
                    }
                    val origin = resolveCallingOrigin(rawOrigin, providerGetRequest.callingAppInfo?.packageName)

                    val rpId = PasskeyUtils.parseRpIdFromGetRequestJson(passkeyOption.requestJson)
                        ?.takeIf { it.isNotBlank() }
                        ?: extractPasskeyRpIdFromOrigin(origin).takeIf { it.isNotBlank() }
                        ?: throw IllegalStateException("Missing rpId in get request")

                    val allowedCredentialIds =
                        PasskeyUtils.parseAllowCredentialIdsFromGetRequestJson(passkeyOption.requestJson)
                    if (allowedCredentialIds.isNotEmpty()) {
                        val containsSelected = allowedCredentialIds.contains(normalizedCredentialId)
                        Log.d(
                            TAG,
                            "Passkey get allowCredentials parsed (count=${allowedCredentialIds.size}, containsSelected=$containsSelected, selected=$normalizedCredentialId)"
                        )
                    }

                    val clientDataHash = passkeyOption.clientDataHash
                        ?: throw IllegalStateException("Missing clientDataHash for assertion")
                    if (clientDataHash.isEmpty()) {
                        throw IllegalStateException("Missing clientDataHash for assertion")
                    }

                    val vaultKey = database.vaultKeyDao().getByVaultId(item.vaultId, item.userId)
                        ?: throw IllegalStateException("Vault key not found")
                    val decryptedVaultKey = VaultDecryptor.decryptVaultKeyWithMuk(vaultKey, muk)

                    val itemDataJson = VaultDecryptor.decryptItemJson(item, decryptedVaultKey)
                    val passkeys = PasskeyUtils.parseStoredPasskeys(itemDataJson)
                    val targetPasskey = passkeys.firstOrNull {
                        PasskeyUtils.canonicalizeCredentialId(it.credentialId) == normalizedCredentialId &&
                            domainsEquivalent(it.rpId, rpId)
                    } ?: throw IllegalStateException("Passkey not found in selected item")

                    val nextSignCount = computeNextSignCount(targetPasskey.signCount)
                    val signResult = NativeCrypto.passkeySignAssertion(
                        privateKeyBase64 = targetPasskey.privateKey,
                        rpId = rpId,
                        clientDataHashBase64 = PasskeyUtils.encodeBase64(clientDataHash),
                        signCount = nextSignCount
                    )
                    if (!signResult.isSuccess || signResult.value == null) {
                        throw IllegalStateException(signResult.error ?: "Assertion signing failed")
                    }

                    val signJson = JSONObject(signResult.value)
                    val authenticatorData = PasskeyUtils.decodeBase64OrBase64Url(
                        signJson.getString("authenticatorData")
                    )
                    val signatureDer = PasskeyUtils.decodeBase64OrBase64Url(
                        signJson.getString("signatureDer")
                    )
                    val credentialIdBytes = PasskeyUtils.decodeBase64OrBase64Url(normalizedCredentialId)
                    val userHandleBytes = try {
                        PasskeyUtils.decodeBase64OrBase64Url(targetPasskey.userHandle)
                    } catch (_: Exception) {
                        ByteArray(0)
                    }

                    // Update passkey metadata in encrypted item payload
                    val nowIso = Instant.now().toString()
                    val passkeyMetadataUpdated = updateStoredPasskeyUsageMetadata(
                        itemDataJson = itemDataJson,
                        credentialId = normalizedCredentialId,
                        rpId = rpId,
                        nextSignCount = nextSignCount,
                        lastUsedAtIso = nowIso
                    )
                    if (!passkeyMetadataUpdated) {
                        Log.w(
                            TAG,
                            "Passkey usage metadata not updated (credentialId=$normalizedCredentialId, rpId=$rpId)"
                        )
                    }

                    val baseVersion = item.version
                    val encryptionVersion = baseVersion + 1L
                    val encryptedItem = VaultDecryptor.encryptItemJson(
                        updatedJson = itemDataJson,
                        vaultKey = decryptedVaultKey,
                        vaultId = item.vaultId,
                        itemId = item.id,
                        version = encryptionVersion,
                        userId = item.userId
                    )
                    val updatedItem = item.copy(
                        encryptedData = encryptedItem.ciphertext,
                        encryptionIv = encryptedItem.iv,
                        encryptionAlgorithm = encryptedItem.algorithm,
                        version = encryptionVersion,
                        lastModifiedBy = item.userId,
                        encryptionVersion = encryptionVersion,
                        encryptedByUserId = item.userId,
                        lastUsedAt = System.currentTimeMillis(),
                        updatedAt = System.currentTimeMillis()
                    )
                    if (passkeyMetadataUpdated) {
                        database.passkeyMutationDao().updateItemAndQueue(
                            updatedItem,
                            pendingPasskeyMutation(
                                userId = item.userId,
                                vaultId = item.vaultId,
                                itemId = item.id,
                                operation = "update_item",
                                encryptedData = encryptedItem.ciphertext,
                                encryptionIv = encryptedItem.iv,
                                encryptionAlgorithm = encryptedItem.algorithm,
                                baseVersion = baseVersion,
                                encryptionVersion = encryptionVersion,
                                encryptedByUserId = item.userId
                            )
                        )
                    } else {
                        database.itemDao().insert(updatedItem)
                    }

                    val requestOptions = PublicKeyCredentialRequestOptions(passkeyOption.requestJson)
                    val packageName = providerGetRequest.callingAppInfo?.packageName ?: ""

                    val assertionResponse = AuthenticatorAssertionResponse(
                        requestOptions,
                        credentialIdBytes,
                        origin,
                        true,
                        true,
                        true,
                        true,
                        userHandleBytes,
                        packageName,
                        clientDataHash
                    ).apply {
                        this.authenticatorData = authenticatorData
                        this.signature = signatureDer
                    }

                    val fidoCredential = FidoPublicKeyCredential(
                        credentialIdBytes,
                        assertionResponse,
                        "platform"
                    )
                    val authenticationResponseJson = fidoCredential.json()

                    GetCredentialResponse(PublicKeyCredential(authenticationResponseJson))
                }

                val resultIntent = Intent()
                PendingIntentHandler.setGetCredentialResponse(resultIntent, result)
                setResult(Activity.RESULT_OK, resultIntent)
                finish()
            } catch (e: Exception) {
                Log.e(TAG, "Error completing passkey assertion", e)
                finishWithError("Failed to complete passkey assertion: ${e.message}")
            }
        }
    }

    /**
     * Complete passkey registration and persist the resulting passkey in local storage.
     */
    private suspend fun completeCreatePasskeyCredential(
        createRequest: ProviderCreateCredentialRequest,
        callingRequest: CreatePublicKeyCredentialRequest,
        context: CreateRequestContext,
        target: PasskeyCreateTarget,
        fallbackUserId: String
    ) {
        withContext(Dispatchers.IO) {
            val targetItem = when (target) {
                is PasskeyCreateTarget.ExistingItem -> target.item
                PasskeyCreateTarget.CreateNewItem -> null
            }

            val resolvedUserId = targetItem?.userId ?: fallbackUserId
            val muk = VaultStateManager.getMasterUnlockKey(resolvedUserId)
                ?: throw IllegalStateException("Vault is locked for selected account")

            val vaultKeyEntity = when (target) {
                is PasskeyCreateTarget.ExistingItem -> {
                    database.vaultKeyDao().getByVaultId(target.item.vaultId, target.item.userId)
                }
                PasskeyCreateTarget.CreateNewItem -> {
                    selectWritableVaultKeyForUser(resolvedUserId)
                }
            } ?: throw IllegalStateException("No writable vault key available")

            val decryptedVaultKey = VaultDecryptor.decryptVaultKeyWithMuk(vaultKeyEntity, muk)
            val keypairResult = NativeCrypto.passkeyGenerateKeypair()
            if (!keypairResult.isSuccess || keypairResult.value == null) {
                throw IllegalStateException(keypairResult.error ?: "Failed to generate passkey keypair")
            }

            val keypairJson = JSONObject(keypairResult.value)
            val privateKeyBase64 = keypairJson.getString("privateKey")
            val publicKeyCoseBase64 = keypairJson.getString("publicKeyCose")
            val publicKeySpkiBase64 = keypairJson.getString("publicKeySpki")

            val credentialIdResult = NativeCrypto.passkeyGenerateCredentialId()
            if (!credentialIdResult.isSuccess || credentialIdResult.value == null) {
                throw IllegalStateException(credentialIdResult.error ?: "Failed to generate credential ID")
            }
            val credentialIdBase64 = credentialIdResult.value
            val credentialId = PasskeyUtils.canonicalizeCredentialId(credentialIdBase64)
                ?: throw IllegalStateException("Invalid generated credential ID")

            val credentialIdBytes = PasskeyUtils.decodeBase64OrBase64Url(credentialId)
            val publicKeyCoseBytes = PasskeyUtils.decodeBase64OrBase64Url(publicKeyCoseBase64)
            val publicKeySpkiBytes = PasskeyUtils.decodeBase64OrBase64Url(publicKeySpkiBase64)
            val attestationResult = NativeCrypto.passkeyBuildAttestationObject(
                rpId = context.rpId,
                credentialIdBase64 = credentialIdBase64,
                cosePublicKeyBase64 = publicKeyCoseBase64,
                signCount = 0
            )
            if (!attestationResult.isSuccess || attestationResult.value == null) {
                throw IllegalStateException(attestationResult.error ?: "Failed to build attestation object")
            }

            val attestationJson = JSONObject(attestationResult.value)
            val attestationObject = PasskeyUtils.decodeBase64OrBase64Url(
                attestationJson.getString("attestationObject")
            )
            val authenticatorData = PasskeyUtils.decodeBase64OrBase64Url(
                attestationJson.getString("authenticatorData")
            )
            val requestedRpId = PasskeyUtils.normalizeHost(context.rpId)
            val passkeyModel = StoredPasskey(
                credentialId = credentialId,
                rpId = requestedRpId,
                rpName = context.rpName,
                userHandle = context.userHandle,
                userName = context.userName,
                userDisplayName = context.userDisplayName,
                privateKey = privateKeyBase64,
                publicKey = publicKeyCoseBase64,
                algorithm = -7,
                signCount = 0,
                transports = listOf("internal", "hybrid"),
                createdAt = Instant.now().toString()
            )

            val updatedItem = if (targetItem != null) {
                val itemDataJson = VaultDecryptor.decryptItemJson(targetItem, decryptedVaultKey)
                appendStoredPasskeyPreservingExisting(itemDataJson, passkeyModel)

                val baseVersion = targetItem.version
                val encryptionVersion = baseVersion + 1L
                val encryptedItem = VaultDecryptor.encryptItemJson(
                    updatedJson = itemDataJson,
                    vaultKey = decryptedVaultKey,
                    vaultId = targetItem.vaultId,
                    itemId = targetItem.id,
                    version = encryptionVersion,
                    userId = targetItem.userId
                )
                targetItem.copy(
                    encryptedData = encryptedItem.ciphertext,
                    encryptionIv = encryptedItem.iv,
                    encryptionAlgorithm = encryptedItem.algorithm,
                    version = encryptionVersion,
                    lastModifiedBy = targetItem.userId,
                    encryptionVersion = encryptionVersion,
                    encryptedByUserId = targetItem.userId,
                    updatedAt = System.currentTimeMillis()
                ).also { item ->
                    database.passkeyMutationDao().updateItemAndQueue(
                        item,
                        pendingPasskeyMutation(
                            userId = item.userId,
                            vaultId = item.vaultId,
                            itemId = item.id,
                            operation = "update_item",
                            encryptedData = encryptedItem.ciphertext,
                            encryptionIv = encryptedItem.iv,
                            encryptionAlgorithm = encryptedItem.algorithm,
                            baseVersion = baseVersion,
                            encryptionVersion = encryptionVersion,
                            encryptedByUserId = item.userId
                        )
                    )
                }
            } else {
                val tempItemId = UUID.randomUUID().toString()
                val primaryUrl = "https://${requestedRpId}"
                val itemDataJson = JSONObject().apply {
                    put("title", context.rpName.ifBlank { requestedRpId })
                    put("username", context.userName)
                    put("url", primaryUrl)
                    put("urls", JSONArray())
                }
                PasskeyUtils.writeStoredPasskeys(itemDataJson, listOf(passkeyModel))

                val encryptedItem = VaultDecryptor.encryptItemJson(
                    updatedJson = itemDataJson,
                    vaultKey = decryptedVaultKey,
                    vaultId = vaultKeyEntity.vaultId,
                    itemId = tempItemId,
                    version = 1L,
                    userId = vaultKeyEntity.userId
                )
                val createdItem = expo.modules.credentialprovider.storage.ItemEntity(
                    id = tempItemId,
                    vaultId = vaultKeyEntity.vaultId,
                    userId = vaultKeyEntity.userId,
                    category = "login",
                    displayTitle = context.rpName.ifBlank { requestedRpId },
                    encryptedData = encryptedItem.ciphertext,
                    encryptionIv = encryptedItem.iv,
                    encryptionAlgorithm = encryptedItem.algorithm,
                    primaryDomain = requestedRpId,
                    username = context.userName,
                    iconUrl = null,
                    lastUsedAt = 0L,
                    syncedAt = System.currentTimeMillis(),
                    createdAt = System.currentTimeMillis(),
                    updatedAt = System.currentTimeMillis(),
                    isFavorite = false,
                    version = 1L,
                    lastModifiedBy = vaultKeyEntity.userId,
                    encryptionVersion = 1L,
                    encryptedByUserId = vaultKeyEntity.userId
                )

                // One row per lookup key, matching how sync indexes items in
                // CredentialProviderModule - a passkey registered at
                // login.example.com would otherwise never be found from an
                // example.com origin.
                database.passkeyMutationDao().createItemAndQueue(
                    createdItem,
                    DomainMatch.lookupKeys(requestedRpId).mapIndexed { index, domain ->
                        ItemDomainEntity(
                            itemId = createdItem.id,
                            domain = domain,
                            isPrimary = index == 0,
                            fullUrl = primaryUrl
                        )
                    },
                    pendingPasskeyMutation(
                        userId = createdItem.userId,
                        vaultId = createdItem.vaultId,
                        itemId = createdItem.id,
                        operation = "create_item",
                        encryptedData = encryptedItem.ciphertext,
                        encryptionIv = encryptedItem.iv,
                        encryptionAlgorithm = encryptedItem.algorithm,
                        baseVersion = 0L,
                        encryptionVersion = 1L,
                        encryptedByUserId = createdItem.userId
                    )
                )
                createdItem
            }

            val rawOrigin = try {
                createRequest.callingAppInfo?.getOrigin(allowlistJson)
            } catch (_: Exception) {
                null
            }
            val origin = resolveCallingOrigin(rawOrigin, createRequest.callingAppInfo?.packageName)
            val creationOptions = PublicKeyCredentialCreationOptions(callingRequest.requestJson)

            val attestationResponse = AuthenticatorAttestationResponse(
                creationOptions,
                credentialIdBytes,
                publicKeyCoseBytes,
                origin,
                true,
                true,
                true,
                true,
                null,
                null
            ).apply {
                this.attestationObject = attestationObject
            }

            val fidoCredential = FidoPublicKeyCredential(
                credentialIdBytes,
                attestationResponse,
                "platform"
            )
            val registrationResponseJson = fidoCredential.json()
            val registrationJson = JSONObject(registrationResponseJson)
            val responseJson = registrationJson.optJSONObject("response")
                ?: JSONObject().also { registrationJson.put("response", it) }
            // Chromium's CredMan bridge requires this field to deserialize create responses.
            responseJson.put("publicKeyAlgorithm", -7)
            responseJson.put("authenticatorData", PasskeyUtils.encodeBase64Url(authenticatorData))
            responseJson.put("publicKey", PasskeyUtils.encodeBase64Url(publicKeySpkiBytes))

            val hasClientDataJson = responseJson.has("clientDataJSON")
            val hasPublicKeyAlgorithm = responseJson.has("publicKeyAlgorithm")
            val hasAuthenticatorData = responseJson.has("authenticatorData")
            val hasPublicKey = responseJson.has("publicKey")
            Log.d(
                TAG,
                "Passkey registration response built (rpId=${context.rpId}, origin=$origin, clientDataJSON=$hasClientDataJson, publicKeyAlgorithm=$hasPublicKeyAlgorithm, authenticatorData=$hasAuthenticatorData, publicKey=$hasPublicKey)"
            )
            val response = CreatePublicKeyCredentialResponse(registrationJson.toString())

            withContext(Dispatchers.Main) {
                val resultIntent = Intent()
                PendingIntentHandler.setCreateCredentialResponse(resultIntent, response)
                setResult(Activity.RESULT_OK, resultIntent)
                Log.d(TAG, "Passkey created and stored on item ${updatedItem.id}")
                finish()
            }
        }
    }


    private suspend fun loadPasskeyCreateCandidates(
        userIds: List<String>,
        rpId: String,
        requestedUserName: String
    ): List<expo.modules.credentialprovider.storage.ItemEntity> {
        val normalizedRpId = PasskeyUtils.normalizeHost(rpId)
        if (normalizedRpId.isBlank()) return emptyList()

        val domainsToQuery = DomainMatch.relyingPartyLookupKeys(normalizedRpId)
        val results = LinkedHashMap<String, expo.modules.credentialprovider.storage.ItemEntity>()
        for (userId in userIds) {
            for (domain in domainsToQuery) {
                val items = database.itemDao().getLoginItemsByDomain(domain, userId)
                for (item in items) {
                    results[item.id] = item
                }
            }
        }

        val candidates = results.values.toList()
        val normalizedRequestedUser = normalizeUsername(requestedUserName)
        if (normalizedRequestedUser.isBlank()) {
            return candidates
        }

        val exactUserMatches = candidates.filter {
            normalizeUsername(it.username) == normalizedRequestedUser
        }
        Log.d(
            TAG,
            "Passkey candidate lookup complete (rpId=$normalizedRpId, domains=$domainsToQuery, requestedUser=$normalizedRequestedUser, total=${candidates.size}, userMatches=${exactUserMatches.size})"
        )
        return if (exactUserMatches.isNotEmpty()) exactUserMatches else candidates
    }

    private suspend fun loadPasskeyCreateCandidatesAnyUser(
        rpId: String,
        requestedUserName: String
    ): List<expo.modules.credentialprovider.storage.ItemEntity> {
        val normalizedRpId = PasskeyUtils.normalizeHost(rpId)
        if (normalizedRpId.isBlank()) return emptyList()

        val domainsToQuery = DomainMatch.relyingPartyLookupKeys(normalizedRpId)
        val results = LinkedHashMap<String, expo.modules.credentialprovider.storage.ItemEntity>()

        val byDomain = database.itemDao().getLoginItemsByDomainsAnyUser(domainsToQuery)
        for (item in byDomain) {
            results[item.id] = item
        }

        val candidates = results.values.toList()
        val normalizedRequestedUser = normalizeUsername(requestedUserName)
        if (normalizedRequestedUser.isBlank()) {
            return candidates
        }

        val exactUserMatches = candidates.filter {
            normalizeUsername(it.username) == normalizedRequestedUser
        }
        return if (exactUserMatches.isNotEmpty()) exactUserMatches else candidates
    }

    private suspend fun loadPasskeyCreateCandidatesByDecryptingItems(
        userIds: List<String>,
        rpId: String,
        requestedUserName: String
    ): List<expo.modules.credentialprovider.storage.ItemEntity> {
        val normalizedRpId = PasskeyUtils.normalizeHost(rpId)
        if (normalizedRpId.isBlank()) return emptyList()
        val normalizedRequestedUser = normalizeUsername(requestedUserName)
        if (normalizedRequestedUser.isBlank()) return emptyList()

        val results = LinkedHashMap<String, expo.modules.credentialprovider.storage.ItemEntity>()
        for (userId in userIds) {
            val muk = VaultStateManager.getMasterUnlockKey(userId) ?: continue
            val loginItems = database.itemDao().getLoginItemsByUserId(userId)
            for (item in loginItems) {
                if (normalizeUsername(item.username) != normalizedRequestedUser) {
                    continue
                }

                val vaultKey = database.vaultKeyDao().getByVaultId(item.vaultId, item.userId)
                    ?: continue

                try {
                    val decryptedVaultKey = VaultDecryptor.decryptVaultKeyWithMuk(vaultKey, muk)
                    val itemDataJson = VaultDecryptor.decryptItemJson(item, decryptedVaultKey)
                    val domains = extractCandidateDomainsFromItemData(itemDataJson)
                    if (domains.any { domainsEquivalent(it, normalizedRpId) }) {
                        results[item.id] = item
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Failed decrypted candidate lookup for item ${item.id}", e)
                }
            }
        }

        return results.values.toList()
    }

    private suspend fun resolvePasskeyCreateTarget(
        candidates: List<expo.modules.credentialprovider.storage.ItemEntity>,
        requestedUserName: String
    ): PasskeyCreateTarget? {
        if (candidates.isEmpty()) return PasskeyCreateTarget.CreateNewItem

        val normalizedRequestedUser = normalizeUsername(requestedUserName)
        if (normalizedRequestedUser.isNotBlank()) {
            val userMatches = candidates.filter {
                normalizeUsername(it.username) == normalizedRequestedUser
            }

            if (userMatches.size == 1) {
                Log.d(TAG, "Auto-selected existing login item by username match")
                return PasskeyCreateTarget.ExistingItem(userMatches.first())
            }

            if (userMatches.size > 1) {
                val bestMatch = userMatches.maxWithOrNull(
                    compareBy<expo.modules.credentialprovider.storage.ItemEntity> {
                        it.lastUsedAt
                    }.thenBy {
                        it.updatedAt
                    }
                ) ?: userMatches.first()
                Log.d(TAG, "Auto-selected most recent login item among username matches")
                return PasskeyCreateTarget.ExistingItem(bestMatch)
            }
        }

        if (candidates.size == 1) {
            return PasskeyCreateTarget.ExistingItem(candidates.first())
        }

        return selectPasskeyCreateTarget(candidates)
    }

    private suspend fun selectPasskeyCreateTarget(
        candidates: List<expo.modules.credentialprovider.storage.ItemEntity>
    ): PasskeyCreateTarget? = suspendCoroutine { continuation ->
        val labels = candidates.map { item ->
            val username = item.username?.takeIf { it.isNotBlank() } ?: "Unknown account"
            "${item.displayTitle.ifBlank { "Login item" }} ($username)"
        }.toMutableList()
        labels.add("Create new login item")

        val dialog = AlertDialog.Builder(this)
            .setTitle("Save passkey to")
            .setItems(labels.toTypedArray()) { _, which ->
                if (which == labels.lastIndex) {
                    continuation.resume(PasskeyCreateTarget.CreateNewItem)
                } else {
                    continuation.resume(PasskeyCreateTarget.ExistingItem(candidates[which]))
                }
            }
            .setOnCancelListener {
                continuation.resume(null)
            }
            .create()

        dialog.show()
    }

    private suspend fun selectWritableVaultKeyForUser(
        userId: String
    ): expo.modules.credentialprovider.storage.VaultKeyEntity? {
        val keys = database.vaultKeyDao().getByUserId(userId)
        if (keys.isEmpty()) return null

        return keys
            .filter { it.role != "read-only" }
            .sortedWith(
                compareBy<expo.modules.credentialprovider.storage.VaultKeyEntity> {
                    if (it.vaultType == "personal") 0 else 1
                }.thenBy { it.vaultName }
            )
            .firstOrNull()
    }

    private fun pendingPasskeyMutation(
        userId: String,
        vaultId: String,
        itemId: String,
        operation: String,
        encryptedData: String,
        encryptionIv: String,
        encryptionAlgorithm: String,
        baseVersion: Long,
        encryptionVersion: Long,
        encryptedByUserId: String
    ): PendingPasskeyMutationEntity {
        return PendingPasskeyMutationEntity(
            id = UUID.randomUUID().toString(),
            userId = userId,
            vaultId = vaultId,
            itemId = itemId,
            operation = operation,
            encryptedData = encryptedData,
            encryptionIv = encryptionIv,
            encryptionAlgorithm = encryptionAlgorithm,
            baseVersion = baseVersion,
            encryptionVersion = encryptionVersion,
            encryptedByUserId = encryptedByUserId,
            createdAt = System.currentTimeMillis(),
            attemptCount = 0,
            lastError = null
        )
    }

    private fun extractPasskeyRpIdFromOrigin(origin: String): String {
        if (!origin.startsWith("http")) return ""
        return DomainMatch.normalizeHost(origin)
    }

    /** Passkey rpId identity, not the wider password-matching rule. */
    private fun domainsEquivalent(left: String, right: String): Boolean =
        DomainMatch.sameRelyingParty(left, right)

    private fun normalizeUsername(value: String?): String {
        return value.orEmpty().trim().lowercase()
    }

    private fun extractCandidateDomainsFromItemData(itemDataJson: JSONObject): Set<String> {
        val domains = LinkedHashSet<String>()

        val primaryUrl = itemDataJson.optString("url")
        val primaryDomain = PasskeyUtils.normalizeHost(primaryUrl)
        if (primaryDomain.isNotBlank()) {
            domains.add(primaryDomain)
        }

        val urls = itemDataJson.optJSONArray("urls")
        if (urls != null) {
            for (index in 0 until urls.length()) {
                val raw = urls.optString(index)
                val domain = PasskeyUtils.normalizeHost(raw)
                if (domain.isNotBlank()) {
                    domains.add(domain)
                }
            }
        }

        val storedPasskeys = PasskeyUtils.parseStoredPasskeys(itemDataJson)
        for (passkey in storedPasskeys) {
            val domain = PasskeyUtils.normalizeHost(passkey.rpId)
            if (domain.isNotBlank()) {
                domains.add(domain)
            }
        }

        return domains
    }

    private fun updateStoredPasskeyUsageMetadata(
        itemDataJson: JSONObject,
        credentialId: String,
        rpId: String,
        nextSignCount: Int,
        lastUsedAtIso: String
    ): Boolean {
        val passkeysJson = itemDataJson.optJSONArray("passkeys") ?: return false
        var updated = false

        for (index in 0 until passkeysJson.length()) {
            val passkeyJson = passkeysJson.optJSONObject(index) ?: continue
            val passkeyCredentialId = extractCanonicalCredentialIdFromPasskeyJson(passkeyJson) ?: continue
            if (passkeyCredentialId != credentialId) {
                continue
            }

            val passkeyRpId = extractRpIdFromPasskeyJson(passkeyJson)
            if (passkeyRpId.isBlank() || !domainsEquivalent(passkeyRpId, rpId)) {
                continue
            }

            passkeyJson.put("signCount", nextSignCount)
            passkeyJson.put("lastUsedAt", lastUsedAtIso)
            updated = true
        }

        return updated
    }

    private fun appendStoredPasskeyPreservingExisting(
        itemDataJson: JSONObject,
        passkey: StoredPasskey
    ) {
        val passkeysJson = itemDataJson.optJSONArray("passkeys")
            ?: JSONArray().also { itemDataJson.put("passkeys", it) }
        passkeysJson.put(serializeStoredPasskey(passkey))
    }

    private fun serializeStoredPasskey(passkey: StoredPasskey): JSONObject {
        val transportsJson = JSONArray()
        for (transport in passkey.transports) {
            transportsJson.put(transport)
        }

        return JSONObject().apply {
            put("credentialId", PasskeyUtils.canonicalizeCredentialId(passkey.credentialId) ?: passkey.credentialId)
            put("rpId", PasskeyUtils.normalizeHost(passkey.rpId))
            put("rpName", passkey.rpName)
            put("userHandle", PasskeyUtils.canonicalizeCredentialId(passkey.userHandle) ?: passkey.userHandle)
            put("userName", passkey.userName)
            put("userDisplayName", passkey.userDisplayName)
            put("privateKey", passkey.privateKey)
            put("publicKey", passkey.publicKey)
            put("algorithm", passkey.algorithm)
            put("signCount", passkey.signCount)
            put("createdAt", passkey.createdAt)
            passkey.lastUsedAt?.let { put("lastUsedAt", it) }
            passkey.status?.let { put("status", it) }
            passkey.statusReason?.let { put("statusReason", it) }
            passkey.statusUpdatedAt?.let { put("statusUpdatedAt", it) }
            put("transports", transportsJson)
        }
    }

    private fun extractCanonicalCredentialIdFromPasskeyJson(passkeyJson: JSONObject): String? {
        val rawValue = when {
            passkeyJson.has("credentialId") -> passkeyJson.opt("credentialId")
            passkeyJson.has("id") -> passkeyJson.opt("id")
            passkeyJson.has("rawId") -> passkeyJson.opt("rawId")
            else -> null
        }

        return canonicalizeCredentialIdFromJsonValue(rawValue)
    }

    private fun extractRpIdFromPasskeyJson(passkeyJson: JSONObject): String {
        val rpId = when {
            passkeyJson.has("rpId") -> passkeyJson.optString("rpId")
            passkeyJson.has("rpID") -> passkeyJson.optString("rpID")
            else -> passkeyJson.optJSONObject("rp")?.optString("id").orEmpty()
        }

        return PasskeyUtils.normalizeHost(rpId)
    }

    private fun canonicalizeCredentialIdFromJsonValue(rawValue: Any?): String? {
        return when (rawValue) {
            is String -> PasskeyUtils.canonicalizeCredentialId(rawValue)
            is JSONArray -> {
                val bytes = ByteArray(rawValue.length())
                for (index in 0 until rawValue.length()) {
                    val numeric = rawValue.optInt(index, -1)
                    if (numeric !in 0..255) return null
                    bytes[index] = numeric.toByte()
                }
                PasskeyUtils.encodeBase64Url(bytes)
            }
            else -> null
        }
    }

    private fun resolveCallingOrigin(originJsonOrString: String?, packageName: String?): String {
        val origins = extractOriginList(originJsonOrString)
        val origin = origins
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

    private fun extractOriginList(originJsonOrString: String?): List<String> {
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
                Log.w(TAG, "Failed to parse origin JSON: $originJsonOrString", e)
            }
        }

        return listOf(originJsonOrString)
    }

    private fun loadAllowlistJson(): String {
        return try {
            val resources = applicationContext.resources
            val resId = resources.getIdentifier(
                "credential_provider_allowlist",
                "raw",
                applicationContext.packageName
            )
            if (resId == 0) {
                Log.w(TAG, "Allowlist resource not found")
                "[]"
            } else {
                resources.openRawResource(resId).bufferedReader().use { it.readText() }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to load allowlist JSON", e)
            "[]"
        }
    }

    /**
     * Launch the main Bittery app for password unlock.
     *
     * @param passwordRequired true if master password re-entry is required (30 days),
     *                         false for regular unlock
     */
    private fun launchAppForPasswordUnlock(passwordRequired: Boolean) {
        try {
            // Create intent to launch the main app
            val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
            if (launchIntent == null) {
                Log.e(TAG, "Could not get launch intent for app")
                finishWithError("Failed to open Bittery app")
                return
            }

            // Add flags to ensure we return to autofill after unlock
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)

            // Add extra to indicate this is an autofill unlock request
            launchIntent.putExtra("autofill_unlock", true)
            launchIntent.putExtra("password_required", passwordRequired)

            // Optional: Add deep link to specific unlock screen
            // The React Native app can handle this via linking configuration
            launchIntent.data = android.net.Uri.parse("bittery://autofill-unlock?passwordRequired=$passwordRequired")

            Log.d(TAG, "Launching app for password unlock (passwordRequired=$passwordRequired)")
            startActivity(launchIntent)

            // Finish this activity - user will come back through autofill flow after unlocking
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
