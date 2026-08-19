/**
 * Chrome extension adapter — a pure mapping of the two ports onto `chrome.storage` and
 * IndexedDB.
 *
 * There is no policy in this file. No JSON, no encryption, no accountId, no expiry, no
 * knowledge of the tier table, and — deliberately — no in-memory cache. Every primitive
 * takes a string and returns `string | null`. All of that policy lives in `AccountStore` /
 * `ItemCache`.
 *
 * | primitive              | backing store               |
 * |------------------------|-----------------------------|
 * | `secret*`              | `chrome.storage.local`      |
 * | `kv*` scope `device`   | `chrome.storage.local`      |
 * | `kv*` scope `session`  | `chrome.storage.session`    |
 * | records                | IndexedDB `bittery_records` |
 * | biometric              | `nullBiometricPort`         |
 *
 * `sessionSurvivesRestart` is `false`: `chrome.storage.session` is cleared when the browser
 * restarts, so `deriveScope` routes session-bound values (`jwt_token`, `vault_keys`,
 * `encrypted_private_key`) there and they are gone afterwards.
 *
 * This is deliberate: without it, an extension's vault keys would outlive the browser
 * session while web, desktop and mobile all treat them as session-bound. Restoring after a
 * service-worker restart is `AccountStore`'s quick-unlock path off `session_data`, which is
 * device-bound by design.
 *
 * The `secret` tier is honoured by mapping it onto `chrome.storage.local` — an extension has
 * no keychain, and `chrome.storage.session` is no stronger at rest — and `secretBacking`
 * says so loudly rather than pretending otherwise.
 *
 * Values are written as raw strings under their own key. No envelope object, so what the
 * port stores is exactly what the port returns, and the empty string is a value rather than
 * an absence.
 */
/// <reference types="chrome" />

import { nullBiometricPort, type PlatformPort } from "../platform-port";
import type { RecordPort } from "../record-port";
import type { StorageScope } from "../tiers";
import { createIndexedDbRecordPort } from "./indexeddb-records";

/**
 * The security-review answer to "is `vault_keys` hardware-backed in the extension?". No.
 * Verbatim from the design contract; the four adapters' strings are compared side by side.
 */
const SECRET_BACKING =
	"chrome.storage.local — NO at-rest separation from the plain tier; the browser profile is the trust boundary";

/**
 * `chrome.storage` is callback-or-promise based; MV3 supports the promise form on every
 * area, so these three wrappers are the entire bridge and there is no callback plumbing.
 */
function scopeArea(scope: StorageScope): chrome.storage.StorageArea {
	return scope === "session" ? chrome.storage.session : chrome.storage.local;
}

/**
 * `get` answers `{}` for a key that was never written, so absence is "the property is not
 * there" — not "the value is falsy". Testing the type rather than the truthiness is what
 * lets the empty string round-trip as a value.
 */
async function readOne(
	area: chrome.storage.StorageArea,
	key: string,
): Promise<string | null> {
	const found = await area.get(key);
	const value = found[key];
	return typeof value === "string" ? value : null;
}

async function writeOne(
	area: chrome.storage.StorageArea,
	key: string,
	value: string,
): Promise<void> {
	await area.set({ [key]: value });
}

/** `remove` of an absent key resolves without error, which is exactly the port contract. */
async function removeOne(
	area: chrome.storage.StorageArea,
	key: string,
): Promise<void> {
	await area.remove(key);
}

export function createChromePlatformPort(): PlatformPort {
	return {
		platform: "extension",
		sessionSurvivesRestart: false,
		tiers: ["secret", "plain"],
		secretBacking: SECRET_BACKING,
		// Records live in IndexedDB, which no native host reads.
		recordKeyPrefix: "",
		biometric: nullBiometricPort,

		initialize: async () => {
			// chrome.storage needs no setup.
		},

		secretGet: async (key) => readOne(chrome.storage.local, key),
		secretSet: async (key, value) => {
			await writeOne(chrome.storage.local, key, value);
		},
		secretDelete: async (key) => {
			await removeOne(chrome.storage.local, key);
		},

		kvGet: async (key, scope) => readOne(scopeArea(scope), key),
		kvSet: async (key, value, scope) => {
			await writeOne(scopeArea(scope), key, value);
		},
		kvDelete: async (key, scope) => {
			await removeOne(scopeArea(scope), key);
		},
		kvListKeys: async (prefix) => {
			// `get(null)` returns the whole area. `getKeys()` would be tidier but only
			// exists from Chrome 130, and this runs once per sweep, not per read.
			const found = new Set<string>();
			for (const area of [chrome.storage.local, chrome.storage.session]) {
				const all = await area.get(null);
				for (const key of Object.keys(all)) {
					if (key.startsWith(prefix)) {
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
 * Identical to web's, because it is literally the same function. An extension service
 * worker gets the same `indexedDB` global a page does, so the record seam has one mapping
 * shared from `indexeddb-records.ts` rather than two copies that could drift apart.
 *
 * Collections are opaque strings chosen by `ItemCache`; the port neither builds them nor
 * parses them.
 */
export function createChromeRecordPort(): RecordPort {
	return createIndexedDbRecordPort();
}
