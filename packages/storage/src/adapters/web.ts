/**
 * Web adapter — a pure mapping of the two ports onto browser storage APIs.
 *
 * There is no policy in this file. No JSON, no encryption, no accountId, no expiry, no
 * knowledge of the tier table. Every primitive takes a string and returns `string | null`.
 * All of that policy lives in `AccountStore` / `ItemCache`.
 *
 * | primitive              | backing store              |
 * |------------------------|----------------------------|
 * | `secret*`              | `localStorage`             |
 * | `kv*` scope `device`   | `localStorage`             |
 * | `kv*` scope `session`  | `sessionStorage`           |
 * | records                | IndexedDB `bittery_records`|
 * | biometric              | `nullBiometricPort`        |
 *
 * `sessionSurvivesRestart` is `false`: a browser tab's `sessionStorage` dies with the tab,
 * so `deriveScope` routes session-bound values (`jwt_token`, `vault_keys`,
 * `encrypted_private_key`) there and they are gone after a restart. That is the intended
 * behaviour, declared once here rather than re-decided at every call site.
 *
 * The `secret` tier is honoured by mapping it onto `localStorage` — the browser has no
 * keychain — and `secretBacking` says so loudly rather than pretending otherwise.
 *
 * Two things this file deliberately does NOT do:
 *   - It does not mint a web accountId. Accounts are `AccountStore`'s concern and the app
 *     seeds the active account at startup. A port must not know what an account is.
 *   - It does not guard against a missing `localStorage` / `indexedDB`. The web app is a
 *     client-rendered Vite SPA, so those globals always exist; swallowing their absence
 *     would silently discard writes.
 */
/// <reference lib="dom" />

import { nullBiometricPort, type PlatformPort } from "../platform-port";
import type { RecordPort } from "../record-port";
import type { StorageScope } from "../tiers";
import { createIndexedDbRecordPort } from "./indexeddb-records";

/**
 * The security-review answer to "is `vault_keys` hardware-backed on web?". No.
 * Verbatim from the design contract; the four adapters' strings are compared side by side.
 */
const SECRET_BACKING =
	"localStorage — NO at-rest separation from the plain tier; the browser profile is the trust boundary";

function scopeStore(scope: StorageScope): Storage {
	return scope === "session" ? sessionStorage : localStorage;
}

export function createWebPlatformPort(): PlatformPort {
	return {
		platform: "web",
		sessionSurvivesRestart: false,
		tiers: ["secret", "plain"],
		secretBacking: SECRET_BACKING,
		// Records live in IndexedDB, which no native host reads.
		recordKeyPrefix: "",
		biometric: nullBiometricPort,

		initialize: async () => {
			// localStorage and sessionStorage need no setup.
		},

		secretGet: async (key) => localStorage.getItem(key),
		secretSet: async (key, value) => {
			localStorage.setItem(key, value);
		},
		secretDelete: async (key) => {
			localStorage.removeItem(key);
		},

		kvGet: async (key, scope) => scopeStore(scope).getItem(key),
		kvSet: async (key, value, scope) => {
			scopeStore(scope).setItem(key, value);
		},
		kvDelete: async (key, scope) => {
			scopeStore(scope).removeItem(key);
		},
		kvListKeys: async (prefix) => {
			const found = new Set<string>();
			for (const store of [localStorage, sessionStorage]) {
				for (let index = 0; index < store.length; index += 1) {
					const key = store.key(index);
					if (key !== null && key.startsWith(prefix)) {
						found.add(key);
					}
				}
			}
			return [...found].sort();
		},
	};
}

// ============================================================================
// Records — IndexedDB
// ============================================================================

/**
 * The IndexedDB record port is shared verbatim with the chrome adapter — a page and an
 * extension service worker get the same `indexedDB`, so there is one mapping and it lives
 * in `indexeddb-records.ts` rather than being copied into both files where the two layouts
 * could drift apart.
 */
export function createWebRecordPort(): RecordPort {
	return createIndexedDbRecordPort();
}
