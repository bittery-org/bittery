/**
 * Theme Storage Service
 * Persists user's theme preference using AsyncStorage
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

const THEME_STORAGE_KEY = "bittery_theme_preference";

export type ThemePreference = "light" | "dark" | "system";

/**
 * Save theme preference to storage
 */
export async function saveThemePreference(
	theme: ThemePreference,
): Promise<void> {
	try {
		await AsyncStorage.setItem(THEME_STORAGE_KEY, theme);
	} catch (error) {
		console.error("[ThemeStorage] Failed to save theme preference:", error);
	}
}

/**
 * Load theme preference from storage
 * Returns "system" if no preference is saved
 */
export async function loadThemePreference(): Promise<ThemePreference> {
	try {
		const savedTheme = await AsyncStorage.getItem(THEME_STORAGE_KEY);
		if (
			savedTheme === "light" ||
			savedTheme === "dark" ||
			savedTheme === "system"
		) {
			return savedTheme;
		}
		return "system"; // Default to system preference
	} catch (error) {
		console.error("[ThemeStorage] Failed to load theme preference:", error);
		return "system";
	}
}

/**
 * Clear theme preference (revert to system default)
 */
export async function clearThemePreference(): Promise<void> {
	try {
		await AsyncStorage.removeItem(THEME_STORAGE_KEY);
	} catch (error) {
		console.error("[ThemeStorage] Failed to clear theme preference:", error);
	}
}
