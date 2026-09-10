import assert from "node:assert/strict";
import test from "node:test";
import {
	validateRecoveryControlRequest,
	validateRecoveryControlResponse,
} from "../generated/recovery-control/validator.js";

test("recovery control is a closed physical family with separately owned bytes", () => {
	const scope = { recoveryId: "recovery", accountId: "account" };
	assert.equal(
		validateRecoveryControlRequest({ type: "readEntry", ...scope }),
		true,
	);
	for (const extra of [
		{ store: "operations" },
		{ sql: "DELETE" },
		{ bytes: [1] },
		{ mutation: "reset" },
	]) {
		assert.equal(
			validateRecoveryControlRequest({ type: "readEntry", ...scope, ...extra }),
			false,
		);
	}
	assert.equal(
		validateRecoveryControlRequest({ type: "stageRowChunk", ...scope }),
		true,
	);
	assert.equal(
		validateRecoveryControlRequest({
			type: "stageRowChunk",
			...scope,
			bytes: [1],
		}),
		false,
	);
	assert.equal(
		validateRecoveryControlRequest({
			type: "sourceRewind",
			...scope,
			capabilityId: "source",
		}),
		true,
	);
	assert.equal(
		validateRecoveryControlRequest({
			type: "commitRepair",
			...scope,
			prepared: { writes: [] },
		}),
		false,
	);
	assert.equal(validateRecoveryControlResponse({ type: "sourceChunk" }), true);
	assert.equal(
		validateRecoveryControlResponse({
			type: "sourceChunk",
			plaintext: "not a control field",
		}),
		false,
	);
});
