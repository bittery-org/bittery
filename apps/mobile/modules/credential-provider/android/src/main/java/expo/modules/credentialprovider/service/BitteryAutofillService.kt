package expo.modules.credentialprovider.service

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
import androidx.annotation.RequiresApi
import expo.modules.credentialprovider.activity.AutofillAuthActivity
import expo.modules.credentialprovider.state.VaultStateManager
import expo.modules.credentialprovider.storage.CredentialDatabase
import expo.modules.credentialprovider.storage.CredentialStorageManager
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

    private val database: CredentialDatabase by lazy {
        CredentialDatabase.getInstance(applicationContext)
    }

    private val storageManager: CredentialStorageManager by lazy {
        CredentialStorageManager(applicationContext)
    }

    private val datasetBuilder: AutofillDatasetBuilder by lazy {
        AutofillDatasetBuilder(applicationContext, database, storageManager)
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
        if (!fieldIds.hasAny()) {
            Log.d(TAG, "No autofillable fields found")
            callback.onSuccess(null)
            return
        }

        val webDomain = extractWebDomain(structure)
        val domain = extractDomain(webDomain)
        Log.d(TAG, "Autofill domain: $domain (webDomain: $webDomain)")

        serviceScope.launch {
            try {
                if (cancellationSignal.isCanceled) return@launch

                val inlineRequest = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    request.inlineSuggestionsRequest
                } else {
                    null
                }

                if (inlineRequest != null) {
                    Log.d(TAG, "Inline suggestions requested: max=${inlineRequest.maxSuggestionCount}, specs=${inlineRequest.inlinePresentationSpecs.size}")
                } else {
                    Log.d(TAG, "Inline suggestions not requested")
                }

                val inlineSpec = inlineRequest?.inlinePresentationSpecs?.firstOrNull()
                val attributionIntent = createAttributionIntent().also { lastAttributionIntent = it }

                val muk = VaultStateManager.getMasterUnlockKey()
                Log.d(TAG, "MUK available: ${muk != null}, Vault unlocked: ${VaultStateManager.isUnlocked()}")

                val datasets = datasetBuilder.buildDatasets(
                    fieldIds = AutofillDatasetBuilder.FieldIds(fieldIds.usernameId, fieldIds.passwordId),
                    domain = domain,
                    muk = muk,
                    inlineSpec = inlineSpec,
                    attributionIntent = attributionIntent
                )

                Log.d(TAG, "Built ${datasets.size} datasets")

                if (datasets.isNotEmpty()) {
                    val responseBuilder = FillResponse.Builder()
                    datasets.forEach { responseBuilder.addDataset(it) }
                    callback.onSuccess(responseBuilder.build())
                    return@launch
                }

                if (!VaultStateManager.isUnlocked()) {
                    val authResponse = buildAuthenticationResponse(fieldIds, domain)
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

    private fun buildAuthenticationResponse(
        fieldIds: FieldIds,
        domain: String?
    ): FillResponse {
        val authIntent = Intent(applicationContext, AutofillAuthActivity::class.java).apply {
            putExtra(EXTRA_AUTOFILL_DOMAIN, domain ?: "")
            fieldIds.usernameId?.let { putExtra(EXTRA_AUTOFILL_USERNAME_ID, it) }
            fieldIds.passwordId?.let { putExtra(EXTRA_AUTOFILL_PASSWORD_ID, it) }
        }

        val pendingIntent = PendingIntent.getActivity(
            applicationContext,
            "autofill_auth".hashCode(),
            authIntent,
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val presentation = android.widget.RemoteViews(packageName, android.R.layout.simple_list_item_1).apply {
            setTextViewText(android.R.id.text1, "Unlock Bittery")
        }

        return FillResponse.Builder()
            .setAuthentication(fieldIds.toArray(), pendingIntent.intentSender, presentation)
            .build()
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
        if (hints.contains(View.AUTOFILL_HINT_USERNAME.lowercase()) ||
            hints.contains(View.AUTOFILL_HINT_EMAIL_ADDRESS.lowercase())
        ) {
            return true
        }

        if (isHtmlUsernameField(node)) {
            return true
        }

        val hintText = node.hint?.toString()?.lowercase().orEmpty()
        val idEntry = node.idEntry?.lowercase().orEmpty()
        return hintText.contains("email") ||
            hintText.contains("user") ||
            idEntry.contains("email") ||
            idEntry.contains("user")
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

    private fun extractDomain(origin: String?): String? {
        if (origin.isNullOrBlank()) return null
        return try {
            if (origin.startsWith("http")) {
                val url = java.net.URL(origin)
                url.host.removePrefix("www.")
            } else {
                origin.removePrefix("www.")
            }
        } catch (e: Exception) {
            origin
        }
    }

    private fun createAttributionIntent(): PendingIntent {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName) ?: Intent()
        return PendingIntent.getActivity(
            applicationContext,
            "autofill_attribution".hashCode(),
            launchIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
    }

    private fun isHtmlPasswordField(node: AssistStructure.ViewNode): Boolean {
        val htmlInfo = node.htmlInfo ?: return false
        val tag = htmlInfo.tag?.lowercase() ?: return false
        if (tag != "input") return false
        val attrs = htmlInfo.attributes ?: return false
        if (attrs.isEmpty()) return false
        val type = findHtmlAttribute(attrs, "type")?.lowercase()
        val autocomplete = findHtmlAttribute(attrs, "autocomplete")?.lowercase()
        return type == "password" ||
            type == "new-password" ||
            type == "current-password" ||
            (autocomplete != null && autocomplete.contains("password"))
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
        return (type == "email" || type == "text") &&
            (autocomplete?.contains("email") == true ||
                autocomplete?.contains("username") == true ||
                name?.contains("email") == true ||
                name?.contains("user") == true ||
                id?.contains("email") == true ||
                id?.contains("user") == true)
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
