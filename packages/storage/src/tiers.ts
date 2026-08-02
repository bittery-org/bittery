/**
 * Storage tiers — the security artifact of this package.
 *
 * `STORAGE_TIERS` below is the complete, reviewable statement of how every persisted
 * value is classified. It is deliberately the ONLY place where sensitivity and lifetime
 * are declared: no adapter, no app and no call site may decide these per platform.
 * A security reviewer should be able to answer "where does `vault_keys` live and how
 * long does it live there?" by reading this one table plus `PlatformPort.secretBacking`.
 *
 * Two orthogonal axes, both universal (never per platform):
 *   - `tier`  — how sensitive is it? (`secret` = key material / credentials, `plain` = settings)
 *   - `class` — does it die with the session? (`session-bound` vs `device-bound`)
 *
 * The single platform-dependent decision, `StorageScope`, is *derived* from `class` by
 * `deriveScope` and never declared per value. That one rule reproduces every legitimate
 * platform difference we actually have.
 */

import type { Platform } from "./types";

/** Sensitivity of a stored value. Universal — not per platform. */
export type StorageTier = "secret" | "plain";

/** Does this value die with the session? Universal — not per platform. */
export type StorageClass = "session-bound" | "device-bound";

/** Derived, never declared per value: where the port must actually put it. */
export type StorageScope = "session" | "device";

export interface ValueTier {
	readonly tier: StorageTier;
	readonly class: StorageClass;
}

/**
 * The table. THIS IS THE SECURITY ARTIFACT — review it as one.
 *
 * Notes that belong with the table:
 *
 * 1. **The plaintext master unlock key (MUK) is never persisted on any platform.**
 *    It has no row here and must never get one. It lives only in `AccountStore`'s
 *    in-memory cache and is therefore session-bound by construction. What *is*
 *    persisted is `session_data`, which carries the MUK **encrypted under `device_key`**;
 *    that pair is device-bound so desktop and mobile can quick-unlock after a restart.
 *
 * 2. `jwt_token` / `vault_keys` / `encrypted_private_key` being session-bound means:
 *    **gone after a browser or extension restart, retained on desktop and mobile.**
 *    On the extension this is a deliberate behaviour change — `vault_keys` used to
 *    survive restart in `chrome.storage.local`. That outlier is what this table fixes.
 *
 * 3. The react-native rule "values under 2000 bytes go to SecureStore, larger values go
 *    to plaintext SQLite" is **deleted**. It silently demoted the largest, most sensitive
 *    blobs (`vault_keys`) out of the secure store. Tier decides placement; size never
 *    does. Oversized secrets are chunked inside the react-native adapter, never demoted.
 */
export const STORAGE_TIERS = {
	// --- secret, session-bound: credentials and key material that must not outlive
	// --- a session on platforms where the session dies with the process.
	jwt_token: { tier: "secret", class: "session-bound" },
	vault_keys: { tier: "secret", class: "session-bound" },
	encrypted_private_key: { tier: "secret", class: "session-bound" },

	// --- secret, device-bound: the quick-unlock pair. `session_data` holds the MUK
	// --- encrypted under `device_key`; neither is useful without the other.
	session_data: { tier: "secret", class: "device-bound" },
	device_key: { tier: "secret", class: "device-bound" },
	secret_key: { tier: "secret", class: "device-bound" },

	// --- plain, device-bound: settings, timestamps and non-sensitive metadata.
	// --- Nothing here may be used to derive or unwrap key material.
	pinned_kdf_params: { tier: "plain", class: "device-bound" },
	server_url: { tier: "plain", class: "device-bound" },
	auto_lock_timeout: { tier: "plain", class: "device-bound" },
	biometric_enabled: { tier: "plain", class: "device-bound" },
	last_biometric_auth: { tier: "plain", class: "device-bound" },
	background_timestamp: { tier: "plain", class: "device-bound" },
	travel_mode_cache: { tier: "plain", class: "device-bound" },
	accounts_list: { tier: "plain", class: "device-bound" },
	active_account: { tier: "plain", class: "device-bound" },
	master_password_reentry_period_ms: { tier: "plain", class: "device-bound" },
	native_view: { tier: "plain", class: "device-bound" },
} as const satisfies Readonly<Record<string, ValueTier>>;

/** Every persisted value name. Keys of STORAGE_TIERS. */
export type StoredValueName = keyof typeof STORAGE_TIERS;

/**
 * The one rule that reproduces every legitimate platform difference.
 *
 * A session-bound value on a platform whose session dies with the process -> "session".
 * Everything else -> "device".
 *
 * `sessionSurvivesRestart` is declared once per adapter (`PlatformPort`):
 *   web `false` | extension `false` | desktop `true` | mobile `true`
 */
export function deriveScope(
	valueClass: StorageClass,
	sessionSurvivesRestart: boolean,
): StorageScope {
	if (valueClass === "session-bound" && !sessionSurvivesRestart) {
		return "session";
	}
	return "device";
}

/** Every tier the table actually demands of a port, in a stable order. */
const REQUIRED_TIERS: readonly StorageTier[] = ["plain", "secret"];

/**
 * Throws at startup if the port cannot honour a tier the table declares.
 *
 * This exists so that a future port which honestly declares it cannot provide, say, the
 * `secret` tier fails loudly at startup instead of silently demoting secrets into plain
 * storage. Ports that map `secret` onto their only store (web, chrome) still declare
 * `["secret", "plain"]` and say so loudly in `PlatformPort.secretBacking`.
 */
export function assertTiersHonoured(port: {
	platform: Platform;
	tiers: readonly StorageTier[];
}): void {
	const missing = REQUIRED_TIERS.filter((tier) => !port.tiers.includes(tier));
	if (missing.length > 0) {
		throw new Error(
			`Platform port "${port.platform}" declares tiers [${port.tiers.join(", ")}] but STORAGE_TIERS requires [${missing.join(", ")}]. Refusing to start rather than silently demoting stored values to a weaker tier.`,
		);
	}
}
