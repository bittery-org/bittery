import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import {
	validateObservationRequest,
	validateRuntimeOutcome,
	validateRuntimeProjection,
	validateRuntimeRequest,
} from "../generated/runtime-protocol/validator.js";

const run = promisify(execFile);

test("generated Runtime protocol artifacts match the Rust contract", async () => {
	await run(
		"node",
		["./scripts/generate-runtime-protocol-contract.mjs", "--check"],
		{ cwd: new URL("..", import.meta.url) },
	);
});

test("generated validators keep the Runtime request surface closed", () => {
	assert.equal(
		validateRuntimeRequest({
			type: "signIn",
			serverUrl: "https://server.test",
			email: "person@server.test",
			masterPassword: "correct horse",
			secretKey: "A3-XXXXXX",
			insecureTransportConfirmed: false,
		}),
		true,
	);
	assert.equal(
		validateRuntimeRequest({
			type: "createLoginItem",
			accountId: "account-1",
			vaultId: "vault-1",
			draft: { title: "Server" },
		}),
		true,
	);
	assert.equal(validateRuntimeRequest({ type: "signOut" }), false);
	assert.equal(
		validateRuntimeRequest({ type: "quickUnlock", accountId: "account-1" }),
		false,
	);
	assert.equal(
		validateObservationRequest({ type: "items", accountId: "account-1" }),
		true,
	);
	assert.equal(
		validateObservationRequest({ type: "runtimeStatus", accountId: null }),
		true,
	);
	assert.equal(validateObservationRequest({ type: "items" }), false);
});

test("the outcome envelope is declared rather than implied by Serde", () => {
	assert.equal(
		validateRuntimeOutcome({
			type: "succeeded",
			value: { type: "signedIn", accountId: "account-1", userId: "user-1" },
		}),
		true,
	);
	assert.equal(
		validateRuntimeOutcome({
			type: "failed",
			value: { code: "AUTHENTICATION_REQUIRED", message: "sign in again" },
		}),
		true,
	);
	// The implicit Serde Result envelope this contract replaces is no longer accepted.
	assert.equal(
		validateRuntimeOutcome({
			Ok: { type: "signedIn", accountId: "account-1", userId: "user-1" },
		}),
		false,
	);
	assert.equal(
		validateRuntimeOutcome({
			type: "failed",
			value: { code: "NotAnErrorCode", message: "unknown" },
		}),
		false,
	);
});

test("every revision crosses the boundary as a canonical decimal string", () => {
	const accepted = (replicaRevision) => ({
		type: "succeeded",
		value: {
			type: "accepted",
			operationId: "operation-1",
			itemId: "item-1",
			replicaRevision,
		},
	});
	assert.equal(validateRuntimeOutcome(accepted("18446744073709551615")), true);
	assert.equal(validateRuntimeOutcome(accepted(7)), false);
	assert.equal(validateRuntimeOutcome(accepted("007")), false);

	assert.equal(
		validateRuntimeProjection({
			type: "items",
			value: {
				accountId: "account-1",
				replicaRevision: "3",
				items: [],
				vaults: [],
			},
		}),
		true,
	);
	assert.equal(
		validateRuntimeProjection({
			type: "items",
			value: {
				accountId: "account-1",
				replicaRevision: 3,
				items: [],
				vaults: [],
			},
		}),
		false,
	);
	assert.equal(
		validateRuntimeProjection({
			type: "runtimeStatus",
			value: {
				accountId: "account-1",
				revision: "9",
				accounts: [
					{
						accountId: "account-1",
						replicaRevision: "9",
						access: "unlocked",
						waitingReason: "reauthenticationRequired",
						failure: null,
					},
				],
				closed: false,
			},
		}),
		true,
	);
});

test("the Item projection keeps the fields the Web host used to drop", () => {
	const projection = (item) => ({
		type: "items",
		value: {
			accountId: "account-1",
			replicaRevision: "1",
			items: [item],
			vaults: [],
		},
	});
	const item = {
		accountId: "account-1",
		itemId: "item-1",
		vaultId: "vault-1",
		title: "Server",
		customFields: [
			{ id: "field-1", label: "PIN", value: "1234", type: "password" },
		],
		tags: ["work"],
		favorite: false,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		status: "pending",
	};
	assert.equal(validateRuntimeProjection(projection(item)), true);
	assert.equal(
		validateRuntimeProjection(projection({ ...item, status: undefined })),
		false,
	);
	assert.equal(
		validateRuntimeProjection(projection({ ...item, status: "Pending" })),
		false,
	);
	assert.equal(
		validateRuntimeProjection(
			projection({
				...item,
				customFields: [
					{ id: "field-1", label: "PIN", value: "1234", type: "pin" },
				],
			}),
		),
		false,
	);
});
