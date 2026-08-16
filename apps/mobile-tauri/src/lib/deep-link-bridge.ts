/**
 * Handles `bittery://…` deep links with `@tauri-apps/plugin-deep-link`.
 *
 * The one real caller today is native, not a browser: the credential-provider plugin's
 * `AutofillAuthActivity.launchAppForUnlock` / `GetCredentialsActivity` (Kotlin, this
 * app's own `src-tauri/plugins/credential-provider`) launch
 * `bittery://autofill-unlock?passwordRequired={true|false}` to bring the app to the
 * foreground for an in-app unlock before autofill can proceed — mirroring
 * `apps/mobile/app/autofill-unlock.tsx`'s dedicated screen and its "Deep link format"
 * doc comment.
 *
 * That native call targets `MainActivity` explicitly
 * (`packageManager.getLaunchIntentForPackage`, not an implicit `ACTION_VIEW`), so it
 * reaches the app regardless of any registered intent-filter — but an *externally*
 * triggered `bittery://` link (e.g. `adb shell am start -a android.intent.action.VIEW
 * -d "bittery://…"`, or a link tapped in another app) is only routable here because
 * `tauri.conf.json`'s `plugins.deep-link.mobile` config makes the plugin's build.rs
 * inject the matching `<intent-filter>` into `gen/android/app/src/main/
 * AndroidManifest.xml` at build time — see the README's Android section for how that
 * survives without ever re-running `tauri android init`.
 *
 * `apps/mobile-tauri` has no dedicated autofill-unlock screen yet — building one is a
 * separate chunk. This routes the link to the existing `/unlock` route's dormant
 * `autoTrigger`/`autoTriggerId` search params instead (see the comment on those params
 * in `src/routes/unlock.tsx`: "Nothing raises this on mobile in M1 — there is no
 * extension — but the param and its handling stay"). A deep link is exactly the mobile
 * trigger that comment anticipated.
 */

import type { createRouter } from "@tanstack/react-router";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";

/**
 * The router's own `navigate`, not the `useNavigate()` hook: this installs before
 * `RouterProvider` renders (`main.tsx`), and even after it renders there is no
 * component in the tree to host the hook — `CredentialProviderSyncBridge` next to
 * `RouterProvider` in `main.tsx` has the same shape, for the same reason.
 */
type Navigate = ReturnType<typeof createRouter>["navigate"];

function handleUrl(url: string, navigate: Navigate): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch (error) {
		console.warn("[deep-link] could not parse URL", url, error);
		return;
	}

	// `bittery://autofill-unlock?...` parses with `host === "autofill-unlock"` (no
	// path segment) under Chromium's URL parser, which is what the Android WebView
	// this app runs in uses.
	if (parsed.protocol !== "bittery:" || parsed.host !== "autofill-unlock") {
		console.warn("[deep-link] unrecognized bittery:// link, ignoring", url);
		return;
	}

	console.log("[deep-link] autofill-unlock ->  /unlock (autoTrigger)", url);
	navigate({
		to: "/unlock",
		search: { autoTrigger: true, autoTriggerId: url },
	});
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
