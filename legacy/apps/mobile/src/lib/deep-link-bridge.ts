/**
 * Handles `bittery://…` deep links with `@tauri-apps/plugin-deep-link`.
 *
 * Two real callers:
 *
 * 1. The credential-provider plugin's `AutofillAuthActivity` /
 *    `GetCredentialsActivity` launch
 *    `bittery://autofill-unlock?passwordRequired={true|false}` to bring the app
 *    to the foreground for an in-app unlock. That native call targets
 *    `MainActivity` explicitly, so it reaches the app regardless of any
 *    registered intent-filter. We route it to `/unlock`'s `autoTrigger` params.
 * 2. Desktop/web "set up another device" copies a
 *    `bittery://login?setup=1…` link (or the user scans that QR with the OS
 *    camera). That has to land on `/login` with `addAccount` so the route
 *    guard does not bounce a device that already has accounts back to
 *    `/unlock`.
 *
 * An *externally* triggered `bittery://` link is only routable because
 * `tauri.conf.json`'s `plugins.deep-link.mobile` config makes the plugin's
 * build.rs inject the matching `<intent-filter>` into
 * `gen/android/app/src/main/AndroidManifest.xml` at build time.
 */

import { parseDeviceSetupParams } from "@bittery/shared/device-setup";
import type { createRouter } from "@tanstack/react-router";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";

/**
 * The router's own `navigate`, not the `useNavigate()` hook: this installs before
 * `RouterProvider` renders (`main.tsx`), and even after it renders there is no
 * component in the tree to host the hook — `CredentialProviderSyncBridge` next to
 * `RouterProvider` in `main.tsx` has the same shape, for the same reason.
 */
type Navigate = ReturnType<typeof createRouter>["navigate"];

export type DeepLinkTarget =
	| {
			to: "/unlock";
			search: { autoTrigger: true; autoTriggerId: string };
	  }
	| {
			to: "/login";
			search: {
				addAccount: true;
				setup: string;
				v: string;
				email: string;
				serverUrl: string;
				teamName?: string;
				secretKey?: string;
			};
	  };

/**
 * Maps a `bittery://` URL to a route. Returns `null` for junk or an unknown
 * host so the installer can ignore it without navigating.
 */
export function resolveDeepLink(url: string): DeepLinkTarget | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}

	// `bittery://autofill-unlock?...` / `bittery://login?...` parse with the
	// route in `host` (no path segment) under Chromium's URL parser, which is
	// what the Android WebView this app runs in uses.
	if (parsed.protocol !== "bittery:") {
		return null;
	}

	if (parsed.host === "autofill-unlock") {
		return {
			to: "/unlock",
			search: { autoTrigger: true, autoTriggerId: url },
		};
	}

	if (parsed.host === "login") {
		let setup: ReturnType<typeof parseDeviceSetupParams>;
		try {
			setup = parseDeviceSetupParams({
				setup: parsed.searchParams.get("setup"),
				v: parsed.searchParams.get("v"),
				email: parsed.searchParams.get("email"),
				serverUrl: parsed.searchParams.get("serverUrl"),
				teamName: parsed.searchParams.get("teamName"),
				secretKey: parsed.searchParams.get("secretKey"),
			});
		} catch {
			return null;
		}
		if (!setup) return null;

		return {
			to: "/login",
			search: {
				addAccount: true,
				setup: "1",
				v: setup.version,
				email: setup.email,
				serverUrl: setup.serverUrl,
				teamName: setup.teamName,
				secretKey: setup.secretKey,
			},
		};
	}

	return null;
}

function handleUrl(url: string, navigate: Navigate): void {
	const target = resolveDeepLink(url);
	if (!target) {
		console.warn("[deep-link] unrecognized bittery:// link, ignoring", url);
		return;
	}

	console.log(`[deep-link] ${target.to}`, url);
	navigate(target);
}

/**
 * Installs the listener and checks for a link the app was cold-started from. Call once
 * after the router exists — `navigate` needs it.
 */
export async function installDeepLinkBridge(navigate: Navigate): Promise<void> {
	await onOpenUrl((urls) => {
		for (const url of urls) {
			handleUrl(url, navigate);
		}
	});
}
