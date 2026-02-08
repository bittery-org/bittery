package expo.modules.credentialprovider.service

import android.app.PendingIntent
import android.content.Context
import android.os.Build
import android.util.Log
import android.view.autofill.AutofillId
import android.view.autofill.AutofillValue
import android.widget.RemoteViews
import android.widget.inline.InlinePresentationSpec
import androidx.annotation.RequiresApi
import androidx.autofill.inline.UiVersions
import androidx.autofill.inline.v1.InlineSuggestionUi
import android.service.autofill.Dataset
import android.service.autofill.InlinePresentation
import expo.modules.credentialprovider.crypto.VaultDecryptor
import expo.modules.credentialprovider.storage.CredentialDatabase
import expo.modules.credentialprovider.storage.CredentialStorageManager
import expo.modules.credentialprovider.storage.ItemEntity

@RequiresApi(Build.VERSION_CODES.O)
class AutofillDatasetBuilder(
    private val context: Context,
    private val database: CredentialDatabase,
    private val storageManager: CredentialStorageManager
) {
    data class FieldIds(
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

    suspend fun buildDatasets(
        fieldIds: FieldIds,
        domain: String?,
        muk: ByteArray?,
        inlineSpec: InlinePresentationSpec?,
        attributionIntent: PendingIntent?,
        userId: String
    ): List<Dataset> {
        val datasets = mutableListOf<Dataset>()
        if (!fieldIds.hasAny()) return datasets

        if (muk != null && !domain.isNullOrBlank()) {
            val items = getItemsForDomain(domain, userId)
            Log.d(BitteryAutofillService.TAG, "Found ${items.size} items for domain: $domain")
            for (item in items) {
                val dataset = buildDatasetFromItem(item, muk, userId, fieldIds, inlineSpec, attributionIntent)
                if (dataset != null) {
                    datasets.add(dataset)
                    if (datasets.size >= BitteryAutofillService.MAX_DATASETS) return datasets
                }
            }
        }

        if (datasets.isNotEmpty()) {
            return datasets
        }

        // IMPORTANT: Don't return legacy credentials if vault is locked
        // Legacy credentials require biometric, but we should respect the vault lock state
        if (muk == null) {
            Log.d(BitteryAutofillService.TAG, "Vault is locked (MUK null), not returning legacy credentials")
            return datasets // Return empty list
        }

        val legacyCredentials = if (!domain.isNullOrBlank()) {
            storageManager.getCredentialsByDomain(domain)
        } else {
            storageManager.getAllCredentials()
        }

        for (credential in legacyCredentials) {
            val dataset = buildDatasetFromLegacyCredential(
                credential.id,
                credential.username,
                credential.displayName,
                fieldIds,
                inlineSpec,
                attributionIntent
            )
            if (dataset != null) {
                datasets.add(dataset)
                if (datasets.size >= BitteryAutofillService.MAX_DATASETS) break
            }
        }

        return datasets
    }

    private suspend fun getItemsForDomain(domain: String, userId: String): List<ItemEntity> {
        val parentDomain = extractParentDomain(domain)
        val items = if (parentDomain.isNotEmpty() && parentDomain != domain) {
            database.itemDao().getLoginItemsByDomainWithFallback(domain, parentDomain, userId)
        } else {
            database.itemDao().getLoginItemsByDomain(domain, userId)
        }

        if (items.isEmpty()) {
            // Debug: Check what domains we have in the database
            val allDomains = try {
                database.itemDomainDao().getAllDomains()
            } catch (e: Exception) {
                emptyList()
            }
            Log.d(BitteryAutofillService.TAG, "No items found for domain '$domain'. Available domains: ${allDomains.take(10)}")
        }

        return items
    }

    private suspend fun buildDatasetFromItem(
        item: ItemEntity,
        muk: ByteArray,
        userId: String,
        fieldIds: FieldIds,
        inlineSpec: InlinePresentationSpec?,
        attributionIntent: PendingIntent?
    ): Dataset? {
        return try {
            val vaultKey = database.vaultKeyDao().getByVaultId(item.vaultId, userId) ?: return null
            val decryptedVaultKey = VaultDecryptor.decryptVaultKeyWithMuk(vaultKey, muk)
            val decryptedItem = VaultDecryptor.decryptLoginItem(item, decryptedVaultKey)
            val username = decryptedItem.username ?: item.username ?: return null
            val password = decryptedItem.password ?: return null
            val label = item.displayTitle.ifBlank { username }
            buildDataset(label, username, password, fieldIds, inlineSpec, attributionIntent)
        } catch (e: Exception) {
            Log.w(BitteryAutofillService.TAG, "Failed to decrypt item ${item.id}", e)
            null
        }
    }

    private suspend fun buildDatasetFromLegacyCredential(
        credentialId: String,
        username: String,
        displayName: String,
        fieldIds: FieldIds,
        inlineSpec: InlinePresentationSpec?,
        attributionIntent: PendingIntent?
    ): Dataset? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return null
        return try {
            val iv = storageManager.getCredentialIv(credentialId) ?: return null
            val cipher = storageManager.biometricKeyManager.getDecryptCipher(iv)
            val password = storageManager.getDecryptedPassword(cipher, credentialId) ?: return null
            val label = displayName.ifBlank { username }
            buildDataset(label, username, password, fieldIds, inlineSpec, attributionIntent)
        } catch (e: Exception) {
            Log.w(BitteryAutofillService.TAG, "Failed to decrypt legacy credential $credentialId", e)
            null
        }
    }

    private fun buildDataset(
        label: String,
        username: String,
        password: String,
        fieldIds: FieldIds,
        inlineSpec: InlinePresentationSpec?,
        attributionIntent: PendingIntent?
    ): Dataset? {
        if (!fieldIds.hasAny()) return null

        Log.d(BitteryAutofillService.TAG, "Building dataset '$label': will fill username=${fieldIds.usernameId != null}, password=${fieldIds.passwordId != null}")

        val presentation = RemoteViews(context.packageName, android.R.layout.simple_list_item_1).apply {
            setTextViewText(android.R.id.text1, label)
        }

        val builder = Dataset.Builder(presentation)
        val inlinePresentation = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && inlineSpec != null && attributionIntent != null) {
            createInlinePresentation(inlineSpec, label, username, attributionIntent)
        } else {
            null
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && inlinePresentation != null) {
            fieldIds.usernameId?.let {
                builder.setValue(it, AutofillValue.forText(username), presentation, inlinePresentation)
            }
            fieldIds.passwordId?.let {
                builder.setValue(it, AutofillValue.forText(password), presentation, inlinePresentation)
            }
        } else {
            fieldIds.usernameId?.let { builder.setValue(it, AutofillValue.forText(username)) }
            fieldIds.passwordId?.let { builder.setValue(it, AutofillValue.forText(password)) }
        }

        return builder.build()
    }

    private fun createInlinePresentation(
        spec: InlinePresentationSpec,
        label: String,
        subtitle: String,
        attributionIntent: PendingIntent
    ): InlinePresentation? {
        val versions = UiVersions.getVersions(spec.style)
        if (!versions.contains(UiVersions.INLINE_UI_VERSION_1)) {
            Log.d(BitteryAutofillService.TAG, "Inline UI version not supported. Available versions: $versions")
            return null
        }

        // Create app icon for the inline suggestion
        val appIcon = android.graphics.drawable.Icon.createWithResource(
            context,
            context.applicationInfo.icon
        )

        val slice = InlineSuggestionUi.newContentBuilder(attributionIntent)
            .setStartIcon(appIcon)
            .setTitle(label)
            .setSubtitle(subtitle)
            .setContentDescription("$label - $subtitle")
            .build()
            .slice

        Log.d(BitteryAutofillService.TAG, "Created inline presentation for: $label ($subtitle)")
        return InlinePresentation(slice, spec, false)
    }

    private fun extractParentDomain(domain: String): String {
        val parts = domain.split(".")
        return if (parts.size > 2) {
            parts.drop(1).joinToString(".")
        } else {
            domain
        }
    }

    /**
     * Creates an "Open Bittery" dataset that launches the main app
     * This appears as the last item in the inline suggestions
     *
     * Note: Sets empty value to satisfy Dataset.Builder requirements
     * When tapped, launches the app via authentication without filling fields
     */
    fun buildOpenAppDataset(
        fieldIds: FieldIds,
        inlineSpec: InlinePresentationSpec?,
        attributionIntent: PendingIntent?
    ): android.service.autofill.Dataset? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || inlineSpec == null || attributionIntent == null) {
            return null
        }

        if (!fieldIds.hasAny()) {
            return null
        }

        val presentation = RemoteViews(context.packageName, android.R.layout.simple_list_item_1).apply {
            setTextViewText(android.R.id.text1, "Open Bittery")
        }

        val appIcon = android.graphics.drawable.Icon.createWithResource(
            context,
            context.applicationInfo.icon
        )

        val inlinePresentation = InlinePresentation(
            InlineSuggestionUi.newContentBuilder(attributionIntent)
                .setStartIcon(appIcon)
                .setTitle("Open Bittery")
                .setContentDescription("Open Bittery app")
                .build()
                .slice,
            inlineSpec,
            false
        )

        val builder = android.service.autofill.Dataset.Builder(presentation)
            .setInlinePresentation(inlinePresentation)
            .setAuthentication(attributionIntent.intentSender)

        // Dataset requires at least one field to be set
        // Set empty value for the first available field
        val fieldId = fieldIds.usernameId ?: fieldIds.passwordId ?: return null
        builder.setValue(fieldId, AutofillValue.forText(""))

        return builder.build()
    }
}
