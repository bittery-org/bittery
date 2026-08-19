package com.bittery.mobile.credentialprovider.service

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BlendMode
import android.graphics.Canvas
import android.graphics.drawable.Icon
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import android.view.autofill.AutofillId
import android.view.autofill.AutofillValue
import android.widget.RemoteViews
import android.widget.inline.InlinePresentationSpec
import androidx.annotation.RequiresApi
import androidx.autofill.inline.UiVersions
import androidx.autofill.inline.v1.InlineSuggestionUi
import android.service.autofill.Dataset
import android.service.autofill.FillResponse
import android.service.autofill.InlinePresentation
import com.bittery.mobile.credentialprovider.R
import com.bittery.mobile.credentialprovider.vault.NativeCredentialVault

/**
 * Turns what the vault offers into what the autofill framework accepts.
 *
 * Internal because it speaks the vault's language on one side and `RemoteViews`,
 * `Dataset` and `FillResponse` on the other. That mapping is the whole job.
 */
@RequiresApi(Build.VERSION_CODES.O)
internal class AutofillDatasetBuilder(
    private val context: Context,
    private val vault: NativeCredentialVault
) {
    private data class PresentationContent(
        val title: String,
        val subtitle: String?
    )

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

    /**
     * The whole response for an unlocked vault: one chip per matching credential
     * plus the pinned brand chip.
     *
     * Both [BitteryAutofillService] on a plain fill and [AutofillAuthActivity]
     * after a biometric unlock build it from here. The activity's response
     * *replaces* the service's, so if the two drifted the strip would come back
     * from the unlock prompt missing chips — or, when the activity forgets the
     * inline specs, empty.
     *
     * Null means "nothing to offer": a FillResponse with no datasets cannot be
     * built, so the caller reports no suggestions instead.
     */
    suspend fun buildUnlockedResponse(
        fieldIds: FieldIds,
        domain: String?,
        inlineSpec: InlinePresentationSpec?,
        pinnedSpec: InlinePresentationSpec?,
        maxSuggestionCount: Int?,
        attributionIntent: PendingIntent?,
    ): FillResponse? {
        if (!fieldIds.hasAny()) return null

        // Live keys only. A cold service gets nothing back and the caller falls
        // back to the auth activity, which can show a prompt.
        val datasets = vault
            .credentialsForOrigin(domain.orEmpty(), BitteryAutofillService.MAX_DATASETS)
            .mapNotNull { credential ->
                buildDataset(
                    label = credential.label,
                    username = credential.username,
                    password = credential.password,
                    fieldIds = fieldIds,
                    inlineSpec = inlineSpec,
                    attributionIntent = attributionIntent,
                )
            }
            .toMutableList()

        val scrollableSlots = InlineSuggestionLayout.scrollableSlotCount(
            maxSuggestionCount,
            includePinnedBrand = pinnedSpec != null,
        )
        if (scrollableSlots != null && datasets.size > scrollableSlots) {
            val originalSize = datasets.size
            datasets.subList(scrollableSlots, datasets.size).clear()
            Log.d(
                BitteryAutofillService.TAG,
                "Trimmed datasets from $originalSize to ${datasets.size} to reserve the pinned brand slot",
            )
        }

        Log.d(BitteryAutofillService.TAG, "Built ${datasets.size} datasets")
        if (datasets.isEmpty()) return null

        val builder = FillResponse.Builder()
        datasets.forEach { builder.addDataset(it) }
        if (attributionIntent != null) {
            buildOpenAppDataset(
                fieldIds = fieldIds,
                inlineSpec = pinnedSpec,
                attributionIntent = attributionIntent,
            )?.let {
                builder.addDataset(it)
                Log.d(BitteryAutofillService.TAG, "Added pinned brand dataset")
            }
        }
        return builder.build()
    }

    /**
     * Where an inline chip's attribution tap goes. Every inline chip needs one,
     * and opening Bittery is the honest answer for all of them.
     */
    fun appLaunchIntent(): PendingIntent {
        val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent()
        return PendingIntent.getActivity(
            context,
            "autofill_attribution".hashCode(),
            launchIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
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

        val presentationContent = buildPresentationContent(label = label, username = username)
        val chip = InlineSuggestionContentSpec.credential(
            title = presentationContent.title,
            subtitle = presentationContent.subtitle,
        )
        Log.d(
            BitteryAutofillService.TAG,
            "Building dataset title='${chip.title}', subtitle='${chip.subtitle ?: ""}': " +
                "will fill username=${fieldIds.usernameId != null}, password=${fieldIds.passwordId != null}"
        )

        val presentation = createMenuPresentation(presentationContent)

        val builder = Dataset.Builder(presentation)
        val inlinePresentation = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && inlineSpec != null && attributionIntent != null) {
            createInlinePresentation(
                spec = inlineSpec,
                content = chip,
                attributionIntent = attributionIntent
            )
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

    private fun buildPresentationContent(label: String, username: String): PresentationContent {
        val normalizedUsername = username.trim()
        val normalizedLabel = label.trim()
        val title = normalizedUsername.ifBlank {
            normalizedLabel.ifBlank { "Login" }
        }
        val subtitle = normalizedLabel.takeIf {
            it.isNotBlank() && !it.equals(title, ignoreCase = true)
        }
        return PresentationContent(title = title, subtitle = subtitle)
    }

    private fun createMenuPresentation(content: PresentationContent): RemoteViews {
        return if (content.subtitle != null) {
            RemoteViews(context.packageName, android.R.layout.simple_list_item_2).apply {
                setTextViewText(android.R.id.text1, content.title)
                setTextViewText(android.R.id.text2, content.subtitle)
            }
        } else {
            RemoteViews(context.packageName, android.R.layout.simple_list_item_1).apply {
                setTextViewText(android.R.id.text1, content.title)
            }
        }
    }

    fun createMenuPresentation(title: String): RemoteViews {
        return RemoteViews(context.packageName, android.R.layout.simple_list_item_1).apply {
            setTextViewText(android.R.id.text1, title)
        }
    }

    fun createInlinePresentation(
        spec: InlinePresentationSpec,
        content: InlineSuggestionContent,
        attributionIntent: PendingIntent
    ): InlinePresentation? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return null
        }

        val versions = UiVersions.getVersions(spec.style)
        if (!versions.contains(UiVersions.INLINE_UI_VERSION_1)) {
            Log.d(BitteryAutofillService.TAG, "Inline UI version not supported. Available versions: $versions")
            return null
        }

        val contentBuilder = InlineSuggestionUi.newContentBuilder(attributionIntent)
            .setContentDescription(content.contentDescription)

        if (content.usesStartIcon) {
            contentBuilder.setStartIcon(brandIcon())
        }
        if (!content.title.isNullOrBlank()) {
            contentBuilder.setTitle(content.title)
        }
        if (!content.subtitle.isNullOrBlank()) {
            contentBuilder.setSubtitle(content.subtitle)
        }

        val slice = contentBuilder.build().slice

        Log.d(
            BitteryAutofillService.TAG,
            "Created inline presentation for: ${content.title ?: "(icon)"} " +
                "(${content.subtitle ?: "no subtitle"}, pinned=${content.pinned})"
        )
        return InlinePresentation(slice, spec, content.pinned)
    }

    /**
     * Icon-only chip pinned to the end of the IME strip. Gboard keeps pinned
     * suggestions visible while the login chips scroll.
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

        val chip = InlineSuggestionContentSpec.openApp()
        val presentation = createMenuPresentation(InlineSuggestionContentSpec.OPEN_APP_DESCRIPTION)
        val inlinePresentation = createInlinePresentation(inlineSpec, chip, attributionIntent)
            ?: return null

        val builder = android.service.autofill.Dataset.Builder(presentation)
            .setInlinePresentation(inlinePresentation)
            .setAuthentication(attributionIntent.intentSender)

        val fieldId = fieldIds.usernameId ?: fieldIds.passwordId ?: return null
        builder.setValue(fieldId, AutofillValue.forText(""))

        return builder.build()
    }

    /**
     * The Bittery mark as a bitmap for the pinned brand chip.
     *
     * Two things make this fiddly. The IME styles inline start icons with its
     * own tint list, which floods an opaque logo into one solid block — that is
     * the black chip Gboard drew. BlendMode.DST keeps the bitmap's own pixels
     * and discards the tint colour, the escape hatch androidx documents on
     * setStartIcon. And the launcher icon is adaptive, so drawing it here would
     * paint the unmasked full square; the packaged mark is already the right
     * shape.
     */
    private fun brandIcon(): Icon {
        val size = (24 * context.resources.displayMetrics.density).toInt().coerceIn(48, 128)
        val source = ContextCompat.getDrawable(context, R.drawable.ic_bittery_app)
            ?: context.packageManager.getApplicationIcon(context.packageName)

        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        source.setBounds(0, 0, size, size)
        source.draw(canvas)

        val icon = Icon.createWithBitmap(bitmap)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            icon.setTintBlendMode(BlendMode.DST)
        }
        return icon
    }
}
