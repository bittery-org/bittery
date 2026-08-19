/**
 * Compile-time pins between `./types` and the generated wire contract.
 *
 * `SyncEvent` is *derived* from `@bittery/api-contract`'s facade type, so its identity fields
 * cannot drift by construction. What can still drift is the three fields the client
 * deliberately re-types — `timestamp`, `vaultId`, `clientId` — because each of those is an
 * `Omit` plus a hand-written replacement, and an `Omit` of a key the wire no longer has is
 * silently a no-op. This file states the conversion at both ends so it fails instead.
 *
 * It is TYPE-ONLY by construction: every declaration is a `type` alias, so nothing is emitted
 * and no module imports this at runtime. The vocabulary mirrors
 * `packages/crypto/port/src/types.drift-guard.ts`, which pins `EncryptionContext.version`
 * across the same `bigint`/`number` seam for the same reason.
 *
 * A guard fails as `Type 'X' does not satisfy the constraint 'true'` where `X` names the
 * field or member that drifted.
 */

import type { SyncEvent as WireSyncEvent } from "@bittery/api-contract";
import type { SyncEvent, SyncMetadataMap } from "./types";

/** Fails as "Type 'false' does not satisfy the constraint 'true'", naming the guard. */
type Assert<Holds extends true> = Holds;

/** `true`, or the members that are on one side only — so the error names them. */
type SameMembers<Left, Right> = [
	Exclude<Left, Right> | Exclude<Right, Left>,
] extends [never]
	? true
	: Exclude<Left, Right> | Exclude<Right, Left>;

/** Field names only. Catches an added or removed field and names it. */
type SameFields<Left, Right> = SameMembers<keyof Left, keyof Right>;

/** Field names *and* field types, by mutual assignability. */
type Identical<Left, Right> = [Left] extends [Right]
	? [Right] extends [Left]
		? true
		: false
	: false;

/**
 * The client event still has exactly the wire's field list. A field added server-side lands
 * here rather than being dropped by every consumer, and a field the wire removes stops the
 * `Omit` below from quietly succeeding against a key that no longer exists.
 */
export type SyncEventFieldsMatchWire = Assert<
	SameFields<SyncEvent, WireSyncEvent>
>;

/**
 * The re-typed `timestamp`, stated as the conversion {@link
 * import("./types").toClientTimestamp} performs. Pinning both ends means a `timestamp` that
 * stops being a `number` above the seam, or stops being a `bigint` below it, fails here
 * instead of silently going through `Number()` — which is exactly how a decimal-string
 * transport gets truncated back into the imprecision it exists to avoid.
 */
export type SyncEventTimestampIsNumberAbove = Assert<
	Identical<SyncEvent["timestamp"], number>
>;
export type SyncEventTimestampIsBigintBelow = Assert<
	Identical<WireSyncEvent["timestamp"], bigint>
>;

/**
 * `vaultId` and `clientId` are resolved from optional-or-null to an explicit `null`. The
 * client value must still be a legal wire value, so the conversion can only ever remove the
 * `undefined` — never widen to something the server cannot mean.
 */
export type SyncEventVaultIdNarrowsWire = Assert<
	Identical<SyncEvent["vaultId"], string | null>
>;
export type SyncEventClientIdNarrowsWire = Assert<
	Identical<SyncEvent["clientId"], string | null>
>;

/**
 * The metadata table covers the generated event union exactly. A new Rust `SyncEventType`
 * variant fails here instead of reaching {@link import("./types").getTypedMetadata} as an
 * unhandled key and resolving to `undefined` metadata at runtime.
 */
export type SyncMetadataMapCoversEventTypes = Assert<
	SameMembers<keyof SyncMetadataMap, SyncEvent["type"]>
>;
