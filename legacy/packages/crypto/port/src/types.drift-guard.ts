/**
 * Compile-time drift guards between the hand-written seam vocabulary in `./types` and the
 * generated uniffi bindings.
 *
 * This package restates the uniffi records instead of re-exporting them, because the port is
 * shared by three adapters and must not import a platform module at runtime — see the
 * `CryptoError` note in `./uniffi-bindings`. ADR 0012 permits that restatement on one
 * condition: a drift guard. This file is it.
 *
 * It is TYPE-ONLY by construction. Every declaration is a `type` alias, so nothing is
 * emitted, nothing imports this module at runtime, and `import type` from
 * `@bittery/crypto-wasm` erases completely. The WASM generator is the reference because both
 * generators emit the same records from the same `uniffi::Record`s; a divergence between the
 * two generators is caught by the binding-diff CI job, not here.
 *
 * A guard fails as `Type 'X' does not satisfy the constraint 'true'` where `X` names the
 * field, key or tag that drifted.
 */

import type {
	CryptoError_Tags as GeneratedCryptoErrorTags,
	DecryptRequest as GeneratedDecryptRequest,
	EncryptedData as GeneratedEncryptedData,
	EncryptionContext as GeneratedEncryptionContext,
	ItemData as GeneratedItemData,
	KdfProfile as GeneratedKdfProfile,
	MemberKeyData as GeneratedMemberKeyData,
	PasskeyAssertion as GeneratedPasskeyAssertion,
	PasskeyAttestation as GeneratedPasskeyAttestation,
	PasskeyKeypair as GeneratedPasskeyKeypair,
	ReEncryptedItem as GeneratedReEncryptedItem,
	RsaKeyPair as GeneratedRsaKeyPair,
	SrpClientEphemeral as GeneratedSrpClientEphemeral,
	SrpClientSession as GeneratedSrpClientSession,
	SrpRegistration as GeneratedSrpRegistration,
	SrpServerChallenge as GeneratedSrpServerChallenge,
	TotpResult as GeneratedTotpResult,
} from "@bittery/crypto-wasm";
import type {
	DecryptRequest,
	PasskeyAssertion,
	PasskeyAttestation,
	PasskeyKeypair,
} from "./crypto-port";
import type {
	EncryptedData,
	EncryptionContext,
	ItemData,
	KdfProfile,
	MemberKeyData,
	ReEncryptedItem,
	RsaKeyPair,
	SRPClientEphemeral,
	SRPClientSession,
	SRPRegistration,
	SRPServerChallenge,
	TotpResult,
} from "./types";
import type {
	UniffiEncryptionContext,
	UniffiErrorTag,
	UniffiItemData,
	UniffiTotpResult,
} from "./uniffi-bindings";

// ============================================================================
// Assertion vocabulary
// ============================================================================

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

/** One direction only, for the places the port is deliberately narrower. */
type AssignableTo<Left, Right> = [Left] extends [Right] ? true : false;

/** Both halves of a record guard: same fields, same field types. */
type Matches<Left, Right> =
	SameFields<Left, Right> extends true
		? Identical<Left, Right>
		: SameFields<Left, Right>;

// ============================================================================
// Records that must match exactly
// ============================================================================

export type EncryptedDataMatchesGenerated = Assert<
	Matches<EncryptedData, GeneratedEncryptedData>
>;
export type RsaKeyPairMatchesGenerated = Assert<
	Matches<RsaKeyPair, GeneratedRsaKeyPair>
>;
export type SrpRegistrationMatchesGenerated = Assert<
	Matches<SRPRegistration, GeneratedSrpRegistration>
>;
export type SrpClientEphemeralMatchesGenerated = Assert<
	Matches<SRPClientEphemeral, GeneratedSrpClientEphemeral>
>;
export type SrpClientSessionMatchesGenerated = Assert<
	Matches<SRPClientSession, GeneratedSrpClientSession>
>;
export type MemberKeyDataMatchesGenerated = Assert<
	Matches<MemberKeyData, GeneratedMemberKeyData>
>;
export type ReEncryptedItemMatchesGenerated = Assert<
	Matches<ReEncryptedItem, GeneratedReEncryptedItem>
>;

// ============================================================================
// Records the seam deliberately re-types
// ============================================================================

/**
 * `EncryptionContext` is the one shape with a conversion rather than a difference of opinion:
 * the core takes `entityType: string` and a `u64` `version`, and the port narrows the first to
 * a closed union and the second to `number`. `UniffiEncryptionContext` is that conversion
 * written down — derived from the port type by `Omit` — so this guard pins the conversion's
 * OUTPUT to the generated record. A field added on either side lands in the `Omit`'s remainder
 * and fails here.
 */
export type EncryptionContextConversionMatchesGenerated = Assert<
	Matches<UniffiEncryptionContext, GeneratedEncryptionContext>
>;

/**
 * The two re-typed fields, stated as the conversion `encryptionContext()` performs. Pinning
 * both ends means a `version` that stops being a `number` above the seam, or stops being a
 * `bigint` below it, fails here rather than silently going through `BigInt()`.
 */
export type EncryptionContextVersionIsNumberAbove = Assert<
	Identical<EncryptionContext["version"], number>
>;
export type EncryptionContextVersionIsBigintBelow = Assert<
	Identical<GeneratedEncryptionContext["version"], bigint>
>;
export type EncryptionContextEntityTypeNarrowsGenerated = Assert<
	AssignableTo<
		EncryptionContext["entityType"],
		GeneratedEncryptionContext["entityType"]
	>
>;

/**
 * `TotpResult` re-types the core's two `u64` second counts as `number`, the same conversion
 * `EncryptionContext.version` gets and for the same reason. `UniffiTotpResult` writes it down,
 * so this guard pins the conversion's INPUT — what `generateTotp` actually hands back — to the
 * generated record, and the two assertions below pin the re-typed fields at both ends.
 */
export type TotpResultConversionMatchesGenerated = Assert<
	Matches<UniffiTotpResult, GeneratedTotpResult>
>;

/** The port's `TotpResult` still has the core's field list; only the counters are re-typed. */
export type TotpResultFieldsMatchGenerated = Assert<
	SameFields<TotpResult, GeneratedTotpResult>
>;

export type TotpSecondsAreNumbersAbove = Assert<
	Identical<TotpResult["remainingSeconds"] | TotpResult["period"], number>
>;
export type TotpSecondsAreBigintsBelow = Assert<
	Identical<
		GeneratedTotpResult["remainingSeconds"] | GeneratedTotpResult["period"],
		bigint
	>
>;

/** The same conversion carried inside a rotation item. */
export type ItemDataConversionMatchesGenerated = Assert<
	Matches<UniffiItemData, GeneratedItemData>
>;

/** The port's `ItemData` still has the core's field list; only `context` is re-typed. */
export type ItemDataFieldsMatchGenerated = Assert<
	SameFields<ItemData, GeneratedItemData>
>;

/**
 * `KdfProfile` pins `schemaVersion` and `algorithm` to single literals because choosing a
 * profile is policy. Narrowing means only one direction can hold, so this asserts the port
 * profile is always a legal argument to the generated function, plus an exact field list.
 */
export type KdfProfileFieldsMatchGenerated = Assert<
	SameFields<KdfProfile, GeneratedKdfProfile>
>;
export type KdfProfileIsAcceptedByGenerated = Assert<
	AssignableTo<KdfProfile, GeneratedKdfProfile>
>;

/**
 * `PasskeyKeypair` drops `publicKeySpki` on purpose (see its declaration). The omission is
 * spelled out rather than tolerated: any OTHER field appearing on either side still fails.
 */
export type PasskeyKeypairMatchesGeneratedWithoutSpki = Assert<
	Matches<PasskeyKeypair, Omit<GeneratedPasskeyKeypair, "publicKeySpki">>
>;

/**
 * The challenge is the core's record exactly. It once carried a `kdfParams` field that the FFI
 * converter silently dropped; the plain equality is what keeps app vocabulary from landing on
 * a seam record where it can look load-bearing without ever being read.
 */
export type SrpServerChallengeMatchesGenerated = Assert<
	Matches<SRPServerChallenge, GeneratedSrpServerChallenge>
>;

/**
 * The passkey byte carriers keep the core's field list but re-type `ArrayBuffer` to
 * `Uint8Array`, which `createCryptoUniffiBackend` converts with `bytes()`. Only the field
 * lists can be asserted; the container swap is the conversion.
 */
export type PasskeyAttestationFieldsMatchGenerated = Assert<
	SameFields<PasskeyAttestation, GeneratedPasskeyAttestation>
>;
export type PasskeyAssertionFieldsMatchGenerated = Assert<
	SameFields<PasskeyAssertion, GeneratedPasskeyAssertion>
>;

/**
 * `DecryptRequest` replaces the generated `KeyHandleLike` with a `KeyRef` and states "no
 * context" as `null` rather than an absent property, so only the field list is shared.
 * `DecryptManyResult` has no guard: the port models it as a discriminated union where the
 * core has a record with two optional fields, and `createCryptoUniffiBackend` narrows it
 * explicitly.
 */
export type DecryptRequestFieldsMatchGenerated = Assert<
	SameFields<DecryptRequest, GeneratedDecryptRequest>
>;

// ============================================================================
// Error tags
// ============================================================================

/**
 * The hand-written tag table in `./uniffi-bindings` must cover the generated `CryptoError`
 * union exactly. A new Rust variant fails here instead of falling through to message sniffing
 * and being reported as a generic `backend-failure`.
 */
export type ErrorTagsCoverGeneratedUnion = Assert<
	SameMembers<UniffiErrorTag, `${GeneratedCryptoErrorTags}`>
>;
