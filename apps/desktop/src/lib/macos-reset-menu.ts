import { invoke } from "@tauri-apps/api/core";
import {
	Menu,
	MenuItem,
	PredefinedMenuItem,
	Submenu,
} from "@tauri-apps/api/menu";
import { Store } from "@tauri-apps/plugin-store";
import { itemCache, storage } from "@/lib/storage";
import { clearDesktopSyncState } from "@/lib/sync-client-id";

const RESET_MENU_ITEM_ID = "bittery-reset-app-completely";

function isMacOS(): boolean {
	return navigator.userAgent.toLowerCase().includes("mac");
}

/** One name, one place: `globalKey("device_key")`, in the OS keychain only. */
const DEVICE_KEY_KEYCHAIN_KEY = "bittery_device_key";

async function resetDesktopAppCompletely(): Promise<void> {
	console.log("[macos-reset-menu] Reset action started");

	// Wipe the accounts *before* `store.json` goes, because the accounts list is what names
	// the per-account keys. Every per-account secret (`session_data`, `vault_keys`,
	// `jwt_token`, `secret_key`, `encrypted_private_key`) is secret-tier now and lives in
	// the OS keychain, so clearing `store.json` alone would leave all of it behind.
	// `clearAllStoredData` routes each delete to whichever store actually holds it, and
	// drops `device_key` once the last account is gone.
	try {
		const accounts = await storage.getAccountsList();
		console.log("[macos-reset-menu] Clearing stored account data", {
			accountCount: accounts.length,
		});
		for (const account of accounts) {
			// A sibling of `storage`, never reachable through it — the cached ciphertext has
			// to be dropped explicitly (packages/storage/CONTEXT.md §4.2).
			await itemCache.clearItemCache(account.accountId);
			await storage.clearAllStoredData(account.accountId);
		}
		console.log("[macos-reset-menu] Cleared stored account data");
	} catch (error) {
		console.warn(
			"[macos-reset-menu] Failed to clear stored account data",
			error,
		);
	}

	try {
		console.log("[macos-reset-menu] Deleting keychain device key");
		await invoke<boolean>("keychain_delete", {
			key: DEVICE_KEY_KEYCHAIN_KEY,
		});
		console.log("[macos-reset-menu] Deleted keychain device key");
	} catch (error) {
		console.warn(
			"[macos-reset-menu] Failed to clear device key from keychain",
			error,
		);
	}

	// This also removes the `bittery_native_view` projection and every `record:` key the
	// item cache uses, so no separate step is needed for either.
	console.log("[macos-reset-menu] Clearing store.json");
	const appStore = await Store.load("store.json");
	await appStore.clear();
	await appStore.save();
	console.log("[macos-reset-menu] Cleared store.json");

	console.log("[macos-reset-menu] Clearing sync store state");
	await clearDesktopSyncState({ preserveClientId: false });
	console.log("[macos-reset-menu] Cleared sync store state");

	console.log("[macos-reset-menu] Clearing browser storage");
	window.localStorage.clear();
	window.sessionStorage.clear();

	if (window.location.pathname !== "/") {
		console.log("[macos-reset-menu] Navigating to /", {
			from: window.location.pathname,
		});
		window.location.assign("/");
		return;
	}

	console.log("[macos-reset-menu] Already on /, reloading");
	window.location.reload();
}

function isSubmenu(item: unknown): item is Submenu {
	return item instanceof Submenu;
}

export async function setupMacOSResetMenu(): Promise<void> {
	const isMac = isMacOS();
	console.log("[macos-reset-menu] setup called", {
		isMac,
		userAgent: navigator.userAgent,
	});

	if (!isMac) return;

	const menu = await Menu.default();
	const topLevelItems = await menu.items();
	console.log("[macos-reset-menu] Loaded default menu", {
		topLevelItemCount: topLevelItems.length,
	});

	const appSubmenu = topLevelItems.find(isSubmenu);
	console.log("[macos-reset-menu] App submenu found", {
		found: Boolean(appSubmenu),
		id: appSubmenu?.id,
	});

	const resetItem = await MenuItem.new({
		id: RESET_MENU_ITEM_ID,
		text: "Reset App Completely…",
		action: () => {
			console.log("[macos-reset-menu] Menu item clicked", {
				id: RESET_MENU_ITEM_ID,
			});
			void resetDesktopAppCompletely();
		},
	});

	if (appSubmenu) {
		const existing = await appSubmenu.get(RESET_MENU_ITEM_ID);
		console.log("[macos-reset-menu] Existing reset item", {
			exists: Boolean(existing),
		});
		if (!existing) {
			const separator = await PredefinedMenuItem.new({ item: "Separator" });
			await appSubmenu.append([separator, resetItem]);
			console.log("[macos-reset-menu] Appended reset item to app submenu");
		}
	} else {
		const fallbackSubmenu = await Submenu.new({
			text: "Bittery",
			items: [resetItem],
		});
		await menu.prepend(fallbackSubmenu);
		console.log("[macos-reset-menu] Created fallback submenu with reset item");
	}

	await menu.setAsAppMenu();
	console.log("[macos-reset-menu] Set menu as app menu");
}
