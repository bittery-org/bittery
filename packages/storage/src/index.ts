/**
 * `@bittery/storage` — client-side storage.
 *
 * Two deep modules and two seams:
 *
 *   - `AccountStore` owns every storage *policy* decision — accountId namespacing, tier
 *     routing, JSON, encryption, session expiry, biometric grace, the native-host
 *     projection — and talks to the platform through `PlatformPort`.
 *   - `ItemCache` owns the disposable encrypted item/vault cache and talks to the platform
 *     through `RecordPort`.
 *
 * Adapters live behind the `./adapters/*` subpaths, not here, so importing this entry point
 * never pulls a platform's optional peer dependencies into a bundle. The in-memory fakes
 * live behind `./testing`.
 */

export type {
	AccountStore,
	AccountStoreOptions,
	NativeHostView,
	NativeKeyRef,
} from "./account-store";
export { createAccountStore, NATIVE_VIEW_VERSION } from "./account-store";
export type { CryptoProvider } from "./crypto-provider";
export type { ItemCache, ItemCacheOptions } from "./item-cache";
export { createItemCache } from "./item-cache";
// The key scheme. Canonical here so `AccountStore`, `ItemCache` and the Rust native host
// can never disagree about a key or a collection name.
export type { AccountValueName, GlobalValueName } from "./keys";
export {
	ACCOUNT_VALUES,
	accountKey,
	GLOBAL_VALUES,
	globalKey,
	itemsCollection,
	metaCollection,
	vaultsCollection,
} from "./keys";
export type {
	BiometricPort,
	BiometricPortResult,
	PlatformPort,
} from "./platform-port";
export { nullBiometricPort } from "./platform-port";
export type { RecordPort } from "./record-port";
// The tier table is the security artifact: it states, once and universally, how sensitive
// each persisted value is and whether it dies with the session.
export type {
	StorageClass,
	StorageScope,
	StorageTier,
	StoredValueName,
	ValueTier,
} from "./tiers";
export { assertTiersHonoured, deriveScope, STORAGE_TIERS } from "./tiers";
export * from "./types";
