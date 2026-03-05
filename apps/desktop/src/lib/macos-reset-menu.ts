import { clearDesktopSyncState } from "@/lib/sync-client-id";
import { invoke } from "@tauri-apps/api/core";
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { Store } from "@tauri-apps/plugin-store";

const RESET_MENU_ITEM_ID = "bittery-reset-app-completely";

function isMacOS(): boolean {
	return navigator.userAgent.toLowerCase().includes("mac");
}

async function resetDesktopAppCompletely(): Promise<void> {
	console.log("[macos-reset-menu] Reset action started");

	console.log("[macos-reset-menu] Clearing store.json");
	const appStore = await Store.load("store.json");
	await appStore.clear();
	await appStore.save();
	console.log("[macos-reset-menu] Cleared store.json");

	console.log("[macos-reset-menu] Clearing sync store state");
	await clearDesktopSyncState({ preserveClientId: false });
	console.log("[macos-reset-menu] Cleared sync store state");

	try {
		console.log("[macos-reset-menu] Deleting keychain device_key");
		await invoke<boolean>("keychain_delete", { key: "device_key" });
		console.log("[macos-reset-menu] Deleted keychain device_key");
	} catch (error) {
		console.warn(
			"[macos-reset-menu] Failed to clear device key from keychain",
			error,
		);
	}

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