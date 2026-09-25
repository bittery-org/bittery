import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import {
	validateNativeAuthorityRequest,
	validateNativeAuthorityResponse,
} from "../generated/native-authority/validator.js";
import { validateRuntimeRequest } from "../generated/runtime-protocol/validator.js";

const run = promisify(execFile);

const nativeScope = {
	accountId: "account",
	incarnation: "incarnation",
	lockEpoch: "0",
	serverUrl: "https://server.test",
	userId: "user",
};

test("native pending episodes use closed states and exact revision values", () => {
	const request = (policyVerification) => ({
		type: "attachDesktop",
		transportId: "destination-port",
		source: {
			version: 1,
			extensionId: "extension",
			ownerId: "owner",
			channelId: "channel",
			transportId: "source-port",
			sequence: "1",
			restrictionFrontier: "0",
			restrictionChainDigest: Array(32).fill(0),
			restrictions: [],
			accounts: [
				{
					scope: nativeScope,
					unlocked: true,
					keyAuthorizationAvailable: false,
					keyGeneration: "0",
					policyVerification,
				},
			],
		},
	});
	for (const state of [
		{ type: "pending", revision: "18446744073709551615" },
		{ type: "verified", revision: "1", restrictionFrontier: "0" },
	]) {
		assert.equal(validateNativeAuthorityRequest(request(state)), true);
		assert.equal(validateRuntimeRequest(request(state)), false);
		assert.equal(
			validateNativeAuthorityRequest(request({ ...state, verified: true })),
			false,
		);
		for (const revision of [1, "-1", "01", "18446744073709551616"]) {
			assert.equal(
				validateNativeAuthorityRequest(request({ ...state, revision })),
				false,
			);
		}
	}
	assert.equal(
		validateNativeAuthorityRequest(
			request({ type: "verified", revision: "1" }),
		),
		false,
	);
	assert.equal(
		validateNativeAuthorityRequest(request({ type: "ready", revision: "1" })),
		false,
	);
});

test("independent native restoration carries bounded nonsecret proof through private controls", () => {
	const challenge = {
		version: 1,
		challengeId: "challenge",
		extensionId: "extension",
		sourceOwner: "source-owner",
		sourceChannel: "source-channel",
		sourceTransport: "source-port",
		destinationOwner: "destination-owner",
		destinationChannel: "destination-channel",
		destinationTransport: "destination-port",
		source: nativeScope,
		sourceKeyGeneration: "0",
		destination: {
			...nativeScope,
			accountId: "destination",
			incarnation: "destination-incarnation",
		},
		newDestination: false,
		destinationInsecureTransportConfirmed: false,
		purpose: {
			type: "revalidateIndependentRestrictions",
			restrictionFrontier: "18446744073709551615",
			restrictionChainDigest: Array(32).fill(0),
			excludedVaultIds: ["vault"],
		},
	};
	const reply = {
		challenge,
		visibleVaultIds: ["vault"],
		sourceSessionExpiresAtMs: "18446744073709551615",
	};
	const response = { type: "independentRestrictionsRevalidated", reply };
	for (const request of [
		{
			type: "prepareIndependentRevalidation",
			channelId: "channel",
			sourceAccount: "source",
		},
		{ type: "revalidateIndependentRestrictions", challenge },
		{ type: "completeIndependentRevalidation", reply },
	]) {
		assert.equal(validateNativeAuthorityRequest(request), true);
		assert.equal(validateRuntimeRequest(request), false);
		assert.equal(
			validateNativeAuthorityRequest({ ...request, token: "forbidden" }),
			false,
		);
	}
	assert.equal(validateNativeAuthorityResponse(response), true);
	for (const field of ["material", "token", "profile"]) {
		assert.equal(
			validateNativeAuthorityResponse({
				...response,
				reply: { ...reply, [field]: "forbidden" },
			}),
			false,
		);
	}
	for (const sourceSessionExpiresAtMs of [
		1,
		"-1",
		"01",
		"18446744073709551616",
	]) {
		assert.equal(
			validateNativeAuthorityResponse({
				...response,
				reply: { ...reply, sourceSessionExpiresAtMs },
			}),
			false,
		);
	}
	for (const restrictionFrontier of [1, "-1", "01", "18446744073709551616"]) {
		assert.equal(
			validateNativeAuthorityRequest({
				type: "revalidateIndependentRestrictions",
				challenge: {
					...challenge,
					purpose: { ...challenge.purpose, restrictionFrontier },
				},
			}),
			false,
		);
	}
	assert.equal(
		validateNativeAuthorityRequest({ type: "completeImport", reply }),
		false,
	);
});

test("native authority artifacts match the private Rust contract", async () => {
	await run(
		"node",
		["./scripts/generate-native-authority-contract.mjs", "--check"],
		{ cwd: new URL("..", import.meta.url) },
	);
});
test("native control stays closed and outside renderer commands", () => {
	const attach = {
		type: "attachSource",
		extensionId: "extension",
		transportId: "port",
	};
	assert.equal(validateNativeAuthorityRequest(attach), true);
	assert.equal(validateRuntimeRequest(attach), false);
	assert.equal(
		validateNativeAuthorityRequest({ ...attach, material: "unexpected" }),
		false,
	);
	assert.equal(
		validateNativeAuthorityRequest({ type: "installKey", key: "unexpected" }),
		false,
	);
	assert.equal(validateNativeAuthorityResponse({ type: "applied" }), true);
	assert.equal(
		validateNativeAuthorityResponse({ type: "applied", token: "unexpected" }),
		false,
	);
});
test("native generations preserve decimal u64 strings without numeric coercion", () => {
	const scope = {
		accountId: "account",
		incarnation: "incarnation",
		lockEpoch: "18446744073709551615",
		serverUrl: "https://server.test",
		userId: "user",
	};
	const authority = {
		scope,
		unlocked: true,
		keyAuthorizationAvailable: true,
		keyGeneration: "18446744073709551615",
	};
	const source = {
		version: 1,
		extensionId: "extension",
		ownerId: "owner",
		channelId: "channel",
		transportId: "port",
		sequence: "18446744073709551615",
		accounts: [authority],
		restrictionFrontier: "0",
		restrictionChainDigest: Array(32).fill(0),
		restrictions: [],
	};
	const request = {
		type: "attachDesktop",
		source,
		transportId: "destination-port",
	};
	assert.equal(validateNativeAuthorityRequest(request), true);
	for (const sequence of [1, "-1", "01", "18446744073709551616"]) {
		assert.equal(
			validateNativeAuthorityRequest({
				...request,
				source: { ...source, sequence },
			}),
			false,
		);
	}
	for (const keyGeneration of [1, "-1", "01", "18446744073709551616"]) {
		assert.equal(
			validateNativeAuthorityRequest({
				...request,
				source: { ...source, accounts: [{ ...authority, keyGeneration }] },
			}),
			false,
		);
	}
	for (const lockEpoch of [1, "-1", "01", "18446744073709551616"]) {
		assert.equal(
			validateNativeAuthorityRequest({
				...request,
				source: {
					...source,
					accounts: [{ ...authority, scope: { ...scope, lockEpoch } }],
				},
			}),
			false,
		);
	}
});

test("source-based preparation keeps destination identity and transport policy in Core", () => {
	const request = {
		type: "prepareImportForSource",
		channelId: "channel",
		sourceAccount: "source",
	};
	assert.equal(validateNativeAuthorityRequest(request), true);
	assert.equal(
		validateNativeAuthorityRequest({
			...request,
			insecureTransportConfirmed: true,
		}),
		true,
	);
	assert.equal(
		validateNativeAuthorityRequest({
			...request,
			destinationAccount: "guessed",
		}),
		false,
	);
	assert.equal(
		validateNativeAuthorityRequest({
			type: "prepareImport",
			channelId: "channel",
			sourceAccount: "source",
			destinationAccount: "guessed",
		}),
		false,
	);
});

test("native profile and optional Travel timestamps retain exact decimal wire values", () => {
	const scope = {
		accountId: "source",
		incarnation: "source-incarnation",
		lockEpoch: "0",
		serverUrl: "https://server.test",
		userId: "user",
	};
	const reply = {
		challenge: {
			version: 1,
			challengeId: "challenge",
			extensionId: "extension",
			sourceOwner: "source-owner",
			sourceChannel: "source-channel",
			sourceTransport: "source-port",
			destinationOwner: "destination-owner",
			destinationChannel: "destination-channel",
			destinationTransport: "destination-port",
			source: scope,
			sourceKeyGeneration: "0",
			destination: {
				...scope,
				accountId: "destination",
				incarnation: "destination-incarnation",
			},
			newDestination: true,
			destinationInsecureTransportConfirmed: false,
		},
		profile: {
			email: "person@example.test",
			name: "Person",
			teamName: null,
			teamAvatarUrl: null,
			secretKeyHint: "ABCDEF",
			addedAtMs: "18446744073709551615",
			lastActiveAtMs: "0",
			biometricEnabled: false,
			pinnedKdfProfile: {
				schemaVersion: 1,
				algorithm: "pbkdf2-sha256",
				iterations: 600000,
			},
		},
		travelEvidence: {
			enabled: true,
			hiddenVaultIds: [],
			serverEnabledAtMs: null,
			serverUpdatedAtMs: "18446744073709551615",
			verifiedAtMs: "0",
		},
		material: "opaque-existing-material",
	};
	const response = { type: "exported", reply };
	assert.equal(validateNativeAuthorityResponse(response), true);
	assert.equal(
		validateNativeAuthorityResponse({
			...response,
			reply: {
				...reply,
				travelEvidence: { ...reply.travelEvidence, verifiedAtMs: null },
			},
		}),
		true,
	);
	const { verifiedAtMs: _receipt, ...missingReceipt } = reply.travelEvidence;
	assert.equal(
		validateNativeAuthorityResponse({
			...response,
			reply: { ...reply, travelEvidence: missingReceipt },
		}),
		false,
	);
	for (const value of [1, "-1", "01", "18446744073709551616"]) {
		assert.equal(
			validateNativeAuthorityResponse({
				...response,
				reply: {
					...reply,
					travelEvidence: { ...reply.travelEvidence, serverUpdatedAtMs: value },
				},
			}),
			false,
		);
		assert.equal(
			validateNativeAuthorityResponse({
				...response,
				reply: { ...reply, profile: { ...reply.profile, addedAtMs: value } },
			}),
			false,
		);
	}
	assert.equal(
		validateNativeAuthorityResponse({
			...response,
			reply: {
				...reply,
				profile: { ...reply.profile, insecureTransportConfirmed: true },
			},
		}),
		false,
	);
});

test("native restriction digests enforce exact byte length and unsigned byte values", () => {
	const source = {
		version: 1,
		extensionId: "extension",
		ownerId: "owner",
		channelId: "channel",
		transportId: "port",
		sequence: "1",
		accounts: [],
		restrictionFrontier: "0",
		restrictionChainDigest: Array(32).fill(0),
		restrictions: [],
	};
	const request = { type: "attachDesktop", source, transportId: "destination" };
	assert.equal(validateNativeAuthorityRequest(request), true);
	for (const digest of [
		Array(31).fill(0),
		Array(33).fill(0),
		[-1, ...Array(31).fill(0)],
		[256, ...Array(31).fill(0)],
		[0.5, ...Array(31).fill(0)],
		["0", ...Array(31).fill(0)],
	]) {
		assert.equal(
			validateNativeAuthorityRequest({
				...request,
				source: { ...source, restrictionChainDigest: digest },
			}),
			false,
		);
	}
});
