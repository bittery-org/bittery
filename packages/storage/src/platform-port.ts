/**
 * The platform seam.
 *
 * A port primitive takes `string` and returns `string | null`. No JSON, no encryption,
 * no accountId, no defaults, no expiry. Every method is total — there are ZERO optional
 * members — so the compiler can verify that an adapter satisfies the contract, and so
 * callers never need `?.` guards or capability probes.
 *
 * All policy lives above this seam in `AccountStore`. An adapter is a pure mapping onto
 * whatever the platform provides; if an adapter starts making decisions, policy has
 * leaked down.
 *
 * Behavioural rules every adapter must obey:
 *   - Missing key -> `null`. Never throws, never returns `undefined`.
 *   - Deleting an absent key is a no-op, never throws.
 *   - `secretSet` and `kvSet` overwrite silently.
 */

import type { StorageScope, StorageTier } from "./tiers";
import type { Platform } from "./types";

/** Biometric hardware. Always present; `nullBiometricPort` on platforms without it. */
export interface BiometricPort {
	isAvailable(): Promise<boolean>;
	getDetails(): Promise<{ hasHardware: boolean; isEnrolled: boolean }>;
	/** e.g. "face" | "fingerprint" | null */
	getType(): Promise<string | null>;
	/**
	 * Reporting the raw outcome is not policy — it is the fact the platform returned.
	 * A bare boolean would collapse "the user pressed cancel" into "authentication failed",
	 * which the UI distinguishes today (react-native maps `user_cancel` / `lockout`;
	 * tauri sniffs "cancel" out of the thrown message). Ports translate their native error
	 * into this closed set and do nothing else with it.
	 */
	authenticate(reason: string): Promise<BiometricPortResult>;
}

export interface BiometricPortResult {
	success: boolean;
	/** Only meaningful when `success` is false. */
	error?:
		| "user_cancelled"
		| "lockout"
		| "not_enrolled"
		| "not_available"
		| "failed";
	message?: string;
}

/**
 * Total no-op implementation for web and the extension.
 *
 * Honest rather than optional: callers ask and get `false`, instead of branching on a
 * `supportsBiometric` capability flag.
 */
export const nullBiometricPort: BiometricPort = {
	isAvailable: async () => false,
	getDetails: async () => ({ hasHardware: false, isEnrolled: false }),
	getType: async () => null,
	authenticate: async () => ({ success: false, error: "not_available" }),
};

export interface PlatformPort {
	readonly platform: Platform;

	/** Does a session survive a process restart on this platform? Feeds deriveScope. */
	readonly sessionSurvivesRestart: boolean;

	/** Tiers this adapter can honour. Checked once at startup by assertTiersHonoured. */
	readonly tiers: readonly StorageTier[];

	/**
	 * Human-readable statement of what actually backs the `secret` tier here.
	 * This string is the security-review answer to "is vault_keys hardware-backed?".
	 * e.g. "macOS/Windows/Linux OS keychain via Tauri keychain_* commands"
	 *      "localStorage — NO at-rest separation from plain tier on this platform"
	 */
	readonly secretBacking: string;

	/**
	 * Prefix under which this platform's `RecordPort` stores a collection, for native hosts
	 * that read the same store directly. Empty string when nothing outside the app reads
	 * records — which is every platform except desktop.
	 *
	 * `AccountStore` concatenates it into the `native_view` projection so the Rust host does
	 * a pure prefix scan and never rebuilds a key format the projection exists to publish.
	 */
	readonly recordKeyPrefix: string;

	initialize(): Promise<void>;

	secretGet(key: string): Promise<string | null>;
	secretSet(key: string, value: string): Promise<void>;
	secretDelete(key: string): Promise<void>;

	kvGet(key: string, scope: StorageScope): Promise<string | null>;
	kvSet(key: string, value: string, scope: StorageScope): Promise<void>;
	kvDelete(key: string, scope: StorageScope): Promise<void>;
	/** Keys currently present in either scope that start with `prefix`. */
	kvListKeys(prefix: string): Promise<string[]>;

	readonly biometric: BiometricPort;
}
