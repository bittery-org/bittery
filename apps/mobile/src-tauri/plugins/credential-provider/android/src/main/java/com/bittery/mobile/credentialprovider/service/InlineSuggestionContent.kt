package com.bittery.mobile.credentialprovider.service

import android.widget.inline.InlinePresentationSpec
import androidx.autofill.inline.UiVersions

/**
 * What an IME chip shows. Pure data so the locked "Unlock Bittery" chip, the
 * login chips and the trailing brand chip stay in one place and can be tested
 * without the Autofill framework.
 *
 * Android's inline UI v1 requires a title **or** a start icon. The trailing
 * brand chip is icon-only on purpose: that is the 1Password-style mark on the
 * right of the suggestion strip. The locked unlock chip keeps its title so it
 * still reads as an action when the IME draws it.
 */
data class InlineSuggestionContent(
    val title: String?,
    val subtitle: String?,
    val contentDescription: String,
    val usesStartIcon: Boolean,
    val pinned: Boolean = false,
) {
    init {
        require(!title.isNullOrBlank() || usesStartIcon) {
            "Inline UI v1 requires a title or a start icon"
        }
    }
}

object InlineSuggestionContentSpec {
    const val UNLOCK_TITLE = "Unlock Bittery"
    const val OPEN_APP_DESCRIPTION = "Open Bittery"

    fun unlock(): InlineSuggestionContent =
        InlineSuggestionContent(
            title = UNLOCK_TITLE,
            subtitle = null,
            contentDescription = UNLOCK_TITLE,
            usesStartIcon = false,
        )

    /**
     * Icon-only chip pinned to the end of the IME strip. Gboard keeps
     * `pinned` suggestions visible while the other chips scroll.
     */
    fun openApp(): InlineSuggestionContent =
        InlineSuggestionContent(
            title = null,
            subtitle = null,
            contentDescription = OPEN_APP_DESCRIPTION,
            usesStartIcon = true,
            pinned = true,
        )

    fun credential(title: String, subtitle: String?): InlineSuggestionContent {
        val resolvedTitle = title.ifBlank { "Login" }
        return InlineSuggestionContent(
            title = resolvedTitle,
            subtitle = subtitle,
            contentDescription = if (subtitle.isNullOrBlank()) {
                resolvedTitle
            } else {
                "$resolvedTitle - $subtitle"
            },
            usesStartIcon = false,
        )
    }
}

/**
 * How many scrollable chips fit once the pinned brand mark has a reserved slot,
 * and which IME spec to use for the pinned vs scrolling chips.
 *
 * Gboard's last spec is the small end-of-strip slot. Using the first spec for
 * the brand chip is why it lined up with the other suggestions and scrolled
 * away.
 */
object InlineSuggestionLayout {
    fun scrollableSlotCount(maxSuggestionCount: Int?, includePinnedBrand: Boolean): Int? {
        if (maxSuggestionCount == null) return null
        val reserved = if (includePinnedBrand) 1 else 0
        return (maxSuggestionCount - reserved).coerceAtLeast(0)
    }

    fun scrollableSpec(specs: List<InlinePresentationSpec>): InlinePresentationSpec? =
        specs.firstOrNull(::isV1)

    fun pinnedSpec(specs: List<InlinePresentationSpec>): InlinePresentationSpec? {
        val v1 = specs.filter(::isV1)
        return v1.lastOrNull()
    }

    private fun isV1(spec: InlinePresentationSpec): Boolean =
        UiVersions.getVersions(spec.style).contains(UiVersions.INLINE_UI_VERSION_1)
}
