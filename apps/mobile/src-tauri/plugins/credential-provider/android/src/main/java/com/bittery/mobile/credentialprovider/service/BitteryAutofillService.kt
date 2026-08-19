package com.bittery.mobile.credentialprovider.service

import android.app.PendingIntent
import android.app.assist.AssistStructure
import android.content.Intent
import android.os.Build
import android.os.CancellationSignal
import android.service.autofill.AutofillService
import android.service.autofill.FillCallback
import android.service.autofill.FillRequest
import android.service.autofill.FillResponse
import android.service.autofill.SaveCallback
import android.service.autofill.SaveRequest
import android.text.InputType
import android.util.Log
import android.util.Pair
import android.view.View
import android.view.autofill.AutofillId
import android.widget.inline.InlinePresentationSpec
import androidx.annotation.RequiresApi
import androidx.autofill.inline.UiVersions
import com.bittery.mobile.credentialprovider.activity.AutofillAuthActivity
import com.bittery.mobile.credentialprovider.vault.NativeCredentialVaults
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

@RequiresApi(Build.VERSION_CODES.O)
class BitteryAutofillService : AutofillService() {
    companion object {
        const val TAG = "BitteryAutofill"
        const val MAX_DATASETS = 20
        const val EXTRA_AUTOFILL_DOMAIN = "autofill_domain"
        const val EXTRA_AUTOFILL_USERNAME_ID = "autofill_username_id"
        const val EXTRA_AUTOFILL_PASSWORD_ID = "autofill_password_id"
    }

    private data class FieldIds(
        val usernameId: AutofillId?,
        val passwordId: AutofillId?
    ) {
        fun hasAny(): Boolean = usernameId != null || passwordId != null

        fun toArray(): Array<AutofillId> {
            val ids = mutableListOf<AutofillId>()
            usernameId?.let { ids.add(it) }
            passwordId?.let { ids.add(it) }
            return ids.toTypedArray()
        }
    }

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    /** The one vault this process has. It is shared with the app and the activities. */
    private val vault by lazy { NativeCredentialVaults.of(applicationContext) }

    private val datasetBuilder: AutofillDatasetBuilder by lazy {
        AutofillDatasetBuilder(applicationContext, vault)
    }

    private var lastAttributionIntent: PendingIntent? = null

    override fun onFillRequest(
        request: FillRequest,
        cancellationSignal: CancellationSignal,
        callback: FillCallback
    ) {
        Log.d(TAG, "onFillRequest called")

        lastAttributionIntent?.cancel()
        lastAttributionIntent = null

        val context = request.fillContexts.lastOrNull()
        if (context == null) {
            callback.onSuccess(null)
            return
        }

        val structure = context.structure
        val fieldIds = findFieldIds(structure)

        Log.d(TAG, "Field detection: username=${fieldIds.usernameId != null}, password=${fieldIds.passwordId != null}")

        if (!fieldIds.hasAny()) {
            Log.w(TAG, "No autofillable fields found - neither username nor password detected")
            callback.onSuccess(null)
            return
        }

        // Passed on as the caller gave it. The vault reduces an origin to the
        // host it names, so this service holds no domain rule of its own.
        val domain = extractWebDomain(structure)
        Log.d(TAG, "Autofill origin: $domain")

        serviceScope.launch {
            try {
                if (cancellationSignal.isCanceled) return@launch

                val inlineRequest = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    request.inlineSuggestionsRequest
                } else {
                    null
                }

                if (inlineRequest != null) {
                    Log.d(TAG, "✓ Inline suggestions requested: max=${inlineRequest.maxSuggestionCount}, specs=${inlineRequest.inlinePresentationSpecs.size}")
                } else {
                    Log.w(TAG, "✗ Inline suggestions NOT requested by IME (keyboard). Will show dropdown instead.")
                    Log.w(TAG, "  → This is controlled by your keyboard, not the autofill service")
                    Log.w(TAG, "  → Check: Gboard settings → Text correction → Show suggestions")
                }

                val inlineSpecs = inlineRequest?.inlinePresentationSpecs.orEmpty()
                val inlineSpec = InlineSuggestionLayout.scrollableSpec(inlineSpecs)
                val pinnedSpec = InlineSuggestionLayout.pinnedSpec(inlineSpecs)
                if (inlineRequest != null && inlineSpec == null) {
                    val availableVersions = inlineSpecs.map { spec ->
                        UiVersions.getVersions(spec.style)
                    }
                    Log.w(TAG, "Inline suggestions requested but no v1-compatible spec found: $availableVersions")
                }
                val inlineMaxSuggestionCount = if (inlineRequest != null && inlineSpec != null) {
                    inlineRequest.maxSuggestionCount.coerceAtLeast(0)
                } else {
                    null
                }
                if (inlineMaxSuggestionCount != null) {
                    Log.d(TAG, "Using inline maxSuggestionCount=$inlineMaxSuggestionCount")
                }
                val attributionIntent = createAttributionIntent().also { lastAttributionIntent = it }

                val unlockedAccountCount = vault.unlockedAccountIds().size
                Log.d(TAG, "Unlocked accounts: $unlockedAccountCount")

                val response = datasetBuilder.buildUnlockedResponse(
                    fieldIds = AutofillDatasetBuilder.FieldIds(fieldIds.usernameId, fieldIds.passwordId),
                    domain = domain,
                    inlineSpec = inlineSpec,
                    pinnedSpec = pinnedSpec,
                    maxSuggestionCount = inlineMaxSuggestionCount,
                    attributionIntent = attributionIntent,
                )
                if (response != null) {
                    callback.onSuccess(response)
                    return@launch
                }

                // Nothing live — a cold service, an auto-lock or a manual lock. The
                // response authenticates instead, so the framework launches
                // AutofillAuthActivity, which can prompt and unwrap from escrow.
                if (vault.unlockedAccountIds().isEmpty()) {
                    val authResponse = buildAuthenticationResponse(
                        fieldIds = fieldIds,
                        domain = domain,
                        inlineSpec = inlineSpec,
                    )
                    callback.onSuccess(authResponse)
                    return@launch
                }

                Log.d(TAG, "No datasets built")
                callback.onSuccess(null)
            } catch (e: Exception) {
                Log.e(TAG, "onFillRequest error", e)
                callback.onFailure(e.message)
            }
        }
    }

    override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
        Log.d(TAG, "onSaveRequest called - not implemented")
        callback.onFailure("Save not supported")
    }

    /**
     * The locked fill: a single "Unlock Bittery" entry that authenticates the
     * *whole response*.
     *
     * Response-level auth on purpose. Dataset-level auth would let a pinned
     * brand chip ride along, but the framework then demands a single [Dataset]
     * back from [AutofillAuthActivity] and silently drops the session when it
     * gets anything else — which is how unlocking used to leave the strip empty
     * until the browser was reloaded. Response-level auth is the shape that
     * takes a FillResponse back, so the credential list appears the moment
     * biometrics pass. The brand chip returns with that response.
     */
    private fun buildAuthenticationResponse(
        fieldIds: FieldIds,
        domain: String?,
        inlineSpec: InlinePresentationSpec?,
    ): FillResponse {
        val authIntent = Intent(applicationContext, AutofillAuthActivity::class.java).apply {
            putExtra(EXTRA_AUTOFILL_DOMAIN, domain ?: "")
            fieldIds.usernameId?.let { putExtra(EXTRA_AUTOFILL_USERNAME_ID, it) }
            fieldIds.passwordId?.let { putExtra(EXTRA_AUTOFILL_PASSWORD_ID, it) }
        }

        // Mutable: the framework adds the assist structure and the IME's
        // InlineSuggestionsRequest to this intent before launching the activity.
        val pendingIntent = PendingIntent.getActivity(
            applicationContext,
            "autofill_auth".hashCode(),
            authIntent,
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val unlock = InlineSuggestionContentSpec.unlock()
        val presentation = datasetBuilder.createMenuPresentation(
            unlock.title ?: InlineSuggestionContentSpec.UNLOCK_TITLE,
        )
        val builder = FillResponse.Builder()

        val inlinePresentation = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && inlineSpec != null) {
            datasetBuilder.createInlinePresentation(
                spec = inlineSpec,
                content = unlock,
                attributionIntent = pendingIntent,
            )
        } else {
            null
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && inlinePresentation != null) {
            builder.setAuthentication(
                fieldIds.toArray(),
                pendingIntent.intentSender,
                presentation,
                inlinePresentation,
            )
        } else {
            builder.setAuthentication(fieldIds.toArray(), pendingIntent.intentSender, presentation)
        }
        return builder.build()
    }

    private fun findFieldIds(structure: AssistStructure): FieldIds {
        var usernameId: AutofillId? = null
        var passwordId: AutofillId? = null

        val windowCount = structure.windowNodeCount
        for (i in 0 until windowCount) {
            val root = structure.getWindowNodeAt(i).rootViewNode
            val result = traverseViewNode(root, usernameId, passwordId)
            usernameId = result.first
            passwordId = result.second
            if (usernameId != null && passwordId != null) break
        }

        return FieldIds(usernameId, passwordId)
    }

    private fun traverseViewNode(
        node: AssistStructure.ViewNode,
        currentUsernameId: AutofillId?,
        currentPasswordId: AutofillId?
    ): Pair<AutofillId?, AutofillId?> {
        var usernameId = currentUsernameId
        var passwordId = currentPasswordId

        val hints = node.autofillHints?.map { it.lowercase() } ?: emptyList()

        if (usernameId == null && isUsernameField(node, hints)) {
            usernameId = node.autofillId
        }

        if (passwordId == null && isPasswordField(node, hints)) {
            passwordId = node.autofillId
        }

        val childCount = node.childCount
        for (i in 0 until childCount) {
            val child = node.getChildAt(i)
            val result = traverseViewNode(child, usernameId, passwordId)
            usernameId = result.first
            passwordId = result.second
            if (usernameId != null && passwordId != null) break
        }

        return Pair(usernameId, passwordId)
    }

    private fun isUsernameField(node: AssistStructure.ViewNode, hints: List<String>): Boolean {
        // Check autofill hints first
        if (hints.contains(View.AUTOFILL_HINT_USERNAME.lowercase()) ||
            hints.contains(View.AUTOFILL_HINT_EMAIL_ADDRESS.lowercase())
        ) {
            return true
        }

        // Check HTML autofill attributes
        if (isHtmlUsernameField(node)) {
            return true
        }

        // Check input type for email
        val inputType = node.inputType
        val isText = inputType and InputType.TYPE_CLASS_TEXT != 0
        val variation = inputType and InputType.TYPE_MASK_VARIATION
        if (isText && variation == InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS) {
            return true
        }

        // Check hint text and ID entry for common username/email patterns
        val hintText = node.hint?.toString()?.lowercase().orEmpty()
        val idEntry = node.idEntry?.lowercase().orEmpty()

        // Comprehensive username/email detection
        val usernamePatterns = listOf("email", "user", "login", "account", "identifier", "username")

        return usernamePatterns.any { pattern ->
            hintText.contains(pattern) || idEntry.contains(pattern)
        } && !isPasswordField(node, hints) // Make sure it's not a password field
    }

    private fun isPasswordField(node: AssistStructure.ViewNode, hints: List<String>): Boolean {
        if (hints.contains(View.AUTOFILL_HINT_PASSWORD.lowercase())) {
            return true
        }

        if (isHtmlPasswordField(node)) {
            return true
        }

        val idEntry = node.idEntry?.lowercase().orEmpty()
        if (idEntry.contains("password") || idEntry.contains("pass")) {
            return true
        }

        val inputType = node.inputType
        val isText = inputType and InputType.TYPE_CLASS_TEXT != 0
        val variation = inputType and InputType.TYPE_MASK_VARIATION
        return isText && (
            variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
                variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD ||
                variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
            )
    }

    private fun extractWebDomain(structure: AssistStructure): String? {
        val windowCount = structure.windowNodeCount
        for (i in 0 until windowCount) {
            val root = structure.getWindowNodeAt(i).rootViewNode
            val found = findWebDomain(root)
            if (!found.isNullOrBlank()) {
                return found
            }
        }
        return null
    }

    private fun findWebDomain(node: AssistStructure.ViewNode): String? {
        val domain = node.webDomain
        if (!domain.isNullOrBlank()) return domain

        val childCount = node.childCount
        for (i in 0 until childCount) {
            val child = node.getChildAt(i)
            val found = findWebDomain(child)
            if (!found.isNullOrBlank()) return found
        }
        return null
    }

    private fun createAttributionIntent(): PendingIntent = datasetBuilder.appLaunchIntent()

    private fun isHtmlPasswordField(node: AssistStructure.ViewNode): Boolean {
        val htmlInfo = node.htmlInfo ?: return false
        val tag = htmlInfo.tag?.lowercase() ?: return false
        if (tag != "input") return false
        val attrs = htmlInfo.attributes ?: return false
        if (attrs.isEmpty()) return false

        val type = findHtmlAttribute(attrs, "type")?.lowercase()
        val autocomplete = findHtmlAttribute(attrs, "autocomplete")?.lowercase()
        val name = findHtmlAttribute(attrs, "name")?.lowercase()

        // Check type attribute
        if (type == "password" || type == "new-password" || type == "current-password") {
            Log.d(TAG, "✓ Password field detected by type=$type")
            return true
        }

        // Check autocomplete attribute
        if (autocomplete != null && autocomplete.contains("password")) {
            Log.d(TAG, "✓ Password field detected by autocomplete=$autocomplete")
            return true
        }

        // Check name attribute as fallback
        if (name != null && (name.contains("password") || name.contains("passwd") || name.contains("pass"))) {
            Log.d(TAG, "✓ Password field detected by name=$name")
            return true
        }

        return false
    }

    private fun isHtmlUsernameField(node: AssistStructure.ViewNode): Boolean {
        val htmlInfo = node.htmlInfo ?: return false
        val tag = htmlInfo.tag?.lowercase() ?: return false
        if (tag != "input") return false
        val attrs = htmlInfo.attributes ?: return false
        if (attrs.isEmpty()) return false

        val type = findHtmlAttribute(attrs, "type")?.lowercase()
        val autocomplete = findHtmlAttribute(attrs, "autocomplete")?.lowercase()
        val name = findHtmlAttribute(attrs, "name")?.lowercase()
        val id = findHtmlAttribute(attrs, "id")?.lowercase()

        // Log HTML attributes for debugging
        Log.d(TAG, "HTML field: type=$type, autocomplete=$autocomplete, name=$name, id=$id")

        // Must be email or text input
        if (type != "email" && type != "text") {
            return false
        }

        // Check autocomplete attribute (most reliable)
        if (autocomplete != null) {
            val validAutocomplete = listOf("email", "username", "webauthn")
            if (validAutocomplete.any { autocomplete.contains(it) }) {
                Log.d(TAG, "✓ Username field detected by autocomplete=$autocomplete")
                return true
            }
        }

        // Check name attribute
        if (name != null) {
            val validNamePatterns = listOf("email", "user", "login", "account", "identifier", "username")
            if (validNamePatterns.any { name.contains(it) }) {
                Log.d(TAG, "✓ Username field detected by name=$name")
                return true
            }
        }

        // Check id attribute
        if (id != null) {
            val validIdPatterns = listOf("email", "user", "login", "account", "identifier", "username")
            if (validIdPatterns.any { id.contains(it) }) {
                Log.d(TAG, "✓ Username field detected by id=$id")
                return true
            }
        }

        return false
    }

    private fun findHtmlAttribute(
        attributes: List<Pair<String, String>>,
        name: String
    ): String? {
        for (pair in attributes) {
            if (pair.first.equals(name, ignoreCase = true)) {
                return pair.second
            }
        }
        return null
    }
}
