package com.bittery.mobile.credentialprovider.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the IME-chip copy and the icon-only vs titled split. The Autofill
 * framework is not on the unit-test classpath in a useful way, so this is the
 * seam: if these values drift, the keyboard bar shows the wrong thing.
 */
class InlineSuggestionContentTest {

    @Test
    fun unlockChipKeepsTheActionTitleWithoutAStartIcon() {
        val chip = InlineSuggestionContentSpec.unlock()
        assertEquals("Unlock Bittery", chip.title)
        assertNull(chip.subtitle)
        assertEquals("Unlock Bittery", chip.contentDescription)
        assertEquals(false, chip.usesStartIcon)
        assertEquals(false, chip.pinned)
    }

    @Test
    fun openAppChipIsAPinnedIconSoTheImeKeepsItOnTheRight() {
        val chip = InlineSuggestionContentSpec.openApp()
        assertNull(chip.title)
        assertNull(chip.subtitle)
        assertEquals("Open Bittery", chip.contentDescription)
        assertTrue(chip.usesStartIcon)
        assertTrue(chip.pinned)
    }

    @Test
    fun credentialChipUsesTheUsernameAsTitle() {
        val chip = InlineSuggestionContentSpec.credential(
            title = "it@body-products.de",
            subtitle = "Domain Factory",
        )
        assertEquals("it@body-products.de", chip.title)
        assertEquals("Domain Factory", chip.subtitle)
        assertEquals("it@body-products.de - Domain Factory", chip.contentDescription)
        assertEquals(false, chip.usesStartIcon)
        assertEquals(false, chip.pinned)
    }

    @Test
    fun credentialChipDropsABlankSubtitleFromTheDescription() {
        val chip = InlineSuggestionContentSpec.credential(
            title = "admin",
            subtitle = null,
        )
        assertEquals("admin", chip.title)
        assertEquals("admin", chip.contentDescription)
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsAChipWithNeitherTitleNorIcon() {
        InlineSuggestionContent(
            title = null,
            subtitle = null,
            contentDescription = "nothing",
            usesStartIcon = false,
        )
    }

    @Test
    fun reservedBrandSlotLeavesRoomForThePinnedIcon() {
        assertEquals(null, InlineSuggestionLayout.scrollableSlotCount(null, true))
        assertEquals(4, InlineSuggestionLayout.scrollableSlotCount(5, true))
        assertEquals(5, InlineSuggestionLayout.scrollableSlotCount(5, false))
        assertEquals(0, InlineSuggestionLayout.scrollableSlotCount(1, true))
    }
}
