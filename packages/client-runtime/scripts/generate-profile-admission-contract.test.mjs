import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import {
	validateProfileAdmissionRequest,
	validateProfileAdmissionResponse,
} from "../generated/profile-admission/validator.js";

const run = promisify(execFile);

test("committed cleanup has separate bounded authority and exact deletion targets", () => {
	const header = {
		version: 1,
		format: "desktopLegacyV1",
		profileIdentity: "profile",
		recordedCaptureId: "original-capture",
		entryCount: "3",
		entriesSha256: "a".repeat(64),
	};
	const start = {
		type: "reopenSourceForCleanup",
		step: {
			type: "start",
			verificationAttemptId: "attempt",
			admissionId: "committed-admission",
			header,
		},
	};
	assert.equal(validateProfileAdmissionRequest(start), true);
	for (const admissionId of ["", "x".repeat(4097), null, 1]) {
		assert.equal(
			validateProfileAdmissionRequest({
				...start,
				step: { ...start.step, admissionId },
			}),
			false,
		);
	}
	const deletion = {
		type: "deleteCapturedSource",
		snapshotHandle: "cleanup-handle",
		admissionId: "committed-admission",
		index: "0",
		expectedEntry: {
			version: 1,
			family: "desktopStore",
			selector: { type: "wholeFile" },
			observation: { type: "fileBytes", length: "17" },
			fileIdentity: "file-identity",
			evidenceSha256: "b".repeat(64),
		},
	};
	assert.equal(validateProfileAdmissionRequest(deletion), true);
	assert.equal(
		validateProfileAdmissionRequest({ ...deletion, path: "/arbitrary" }),
		false,
	);
	for (const index of [0, "00", "18446744073709551616"]) {
		assert.equal(
			validateProfileAdmissionRequest({ ...deletion, index }),
			false,
		);
	}
	for (const type of ["deleted", "alreadyAbsent", "changed", "unavailable"]) {
		const receipt = {
			type: "sourceCleanupResult",
			snapshotHandle: "cleanup-handle",
			admissionId: "committed-admission",
			index: "0",
			result: { type },
		};
		assert.equal(validateProfileAdmissionResponse(receipt), true);
		assert.equal(
			validateProfileAdmissionResponse({
				...receipt,
				result: { ...receipt.result, path: "/arbitrary" },
			}),
			false,
		);
	}
	const snapshot = {
		format: "desktopLegacyV1",
		snapshotHandle: "cleanup-handle",
		profileIdentity: "profile",
		captureId: "fresh-capture",
		admissionId: "committed-admission",
	};
	assert.equal(
		validateProfileAdmissionResponse({
			type: "sourceCleanupReopen",
			result: { type: "reopened", snapshot },
		}),
		true,
	);
	assert.equal(
		validateProfileAdmissionResponse({ type: "sourceSnapshot", snapshot }),
		false,
	);
});

test("generated profile source artifacts match the Rust contract", async () => {
	await run(
		"node",
		["./scripts/generate-profile-admission-contract.mjs", "--check"],
		{ cwd: new URL("..", import.meta.url) },
	);
});

test("source pages require a closed selector and an explicit nullable cursor", () => {
	const request = {
		type: "readSourcePage",
		snapshotHandle: "live-snapshot",
		family: "desktopCredentials",
		selector: {
			type: "accountCredential",
			accountId: "acct_opaque_original",
			field: "sessionData",
		},
		cursor: null,
	};
	assert.equal(validateProfileAdmissionRequest(request), true);
	const { cursor: _cursor, ...withoutCursor } = request;
	assert.equal(validateProfileAdmissionRequest(withoutCursor), false);
	for (const cursor of ["", "x".repeat(98305), 0, {}]) {
		assert.equal(
			validateProfileAdmissionRequest({ ...request, cursor }),
			false,
		);
	}
	assert.equal(
		validateProfileAdmissionRequest({ ...request, cursor: "x".repeat(98304) }),
		true,
	);
	for (const selector of [
		{ ...request.selector, accountId: "" },
		{ ...request.selector, field: "futureSecret" },
		{ ...request.selector, path: "/arbitrary/source" },
		{ type: "wholeFile", path: "store.json" },
	]) {
		assert.equal(
			validateProfileAdmissionRequest({ ...request, selector }),
			false,
		);
	}
});

test("source byte counts retain canonical u64 precision and contain no payload JSON", () => {
	const page = {
		type: "sourcePage",
		snapshotHandle: "live-snapshot",
		family: "desktopStore",
		selector: { type: "wholeFile" },
		observation: { type: "fileBytes", length: "18446744073709551615" },
		offset: "18446744073709551614",
		byteLength: "1",
		continuation: { type: "end" },
	};
	assert.equal(validateProfileAdmissionResponse(page), true);
	for (const length of [
		0,
		9007199254740992,
		"",
		"01",
		"-1",
		"1.0",
		"1e3",
		"18446744073709551616",
	]) {
		assert.equal(
			validateProfileAdmissionResponse({
				...page,
				observation: { ...page.observation, length },
			}),
			false,
		);
	}
	for (const extra of [{ bytes: [0, 255] }, { payload: "AP8=" }]) {
		assert.equal(
			validateProfileAdmissionResponse({ ...page, ...extra }),
			false,
		);
	}
	assert.equal(
		validateProfileAdmissionResponse({
			...page,
			continuation: { type: "end", cursor: "contradictory" },
		}),
		false,
	);
});

test("absence and unsupported values remain distinct closed observations", () => {
	const page = {
		type: "sourcePage",
		snapshotHandle: "live-snapshot",
		family: "desktopCredentials",
		selector: { type: "globalCredential", field: "deviceKey" },
		offset: "0",
		byteLength: "0",
		continuation: { type: "end" },
	};
	for (const observation of [
		{ type: "missing" },
		{ type: "storedString", encoding: "utf8", length: "0" },
		{ type: "storedString", encoding: "utf16Le", length: "0" },
		...["null", "boolean", "number", "array", "object", "otherUnsupported"].map(
			(valueKind) => ({ type: "presentUnsupported", valueKind }),
		),
	]) {
		assert.equal(
			validateProfileAdmissionResponse({ ...page, observation }),
			true,
		);
	}
	for (const observation of [
		{ type: "missing", value: null },
		{ type: "presentUnsupported", valueKind: "futureKind" },
		{ type: "storedString", encoding: "utf8", length: "0", value: "" },
	]) {
		assert.equal(
			validateProfileAdmissionResponse({ ...page, observation }),
			false,
		);
	}
	assert.equal(
		validateProfileAdmissionResponse({
			type: "sourceSnapshotClosed",
			ignored: true,
		}),
		false,
	);
	for (const invalid of [
		["sourceSnapshotClosed"],
		{
			...page,
			selector: ["globalCredential", "deviceKey"],
			observation: { type: "missing" },
		},
		{ ...page, observation: ["missing"] },
		{ ...page, observation: { type: "missing" }, continuation: ["end"] },
	]) {
		assert.equal(validateProfileAdmissionResponse(invalid), false);
	}
});

test("verification controls keep reopen and live verification starts distinct", () => {
	const header = {
		version: 1,
		format: "desktopLegacyV1",
		profileIdentity: "profile",
		recordedCaptureId: "original-capture",
		entryCount: "1",
		entriesSha256: "0".repeat(64),
	};
	const verify = {
		type: "verifySourceSnapshot",
		step: {
			type: "start",
			verificationAttemptId: "verify-attempt",
			snapshotHandle: "live-source",
			header,
		},
	};
	assert.equal(validateProfileAdmissionRequest(verify), true);
	const { snapshotHandle: _snapshotHandle, ...withoutHandle } = verify.step;
	assert.equal(
		validateProfileAdmissionRequest({ ...verify, step: withoutHandle }),
		false,
	);

	const reopen = {
		type: "reopenSourceSnapshot",
		step: {
			type: "start",
			verificationAttemptId: "reopen-attempt",
			header,
		},
	};
	assert.equal(validateProfileAdmissionRequest(reopen), true);
	assert.equal(
		validateProfileAdmissionRequest({
			...reopen,
			step: { ...reopen.step, snapshotHandle: "stale-source" },
		}),
		false,
	);

	for (const malformedHeader of [
		{ ...header, version: 2 },
		{ ...header, entryCount: "01" },
		{ ...header, entriesSha256: "A".repeat(64) },
		{ ...header, entriesSha256: "0".repeat(63) },
	]) {
		assert.equal(
			validateProfileAdmissionRequest({
				...reopen,
				step: { ...reopen.step, header: malformedHeader },
			}),
			false,
		);
	}

	const entry = {
		type: "verifySourceSnapshot",
		step: {
			type: "entry",
			verificationCursor: "verification-cursor",
			index: "0",
			expectedEntry: {
				version: 1,
				family: "desktopCredentials",
				selector: { type: "globalCredential", field: "deviceKey" },
				observation: { type: "missing" },
				fileIdentity: null,
				evidenceSha256: "0".repeat(64),
			},
		},
	};
	assert.equal(validateProfileAdmissionRequest(entry), true);
	const { fileIdentity: _fileIdentity, ...withoutFileIdentity } =
		entry.step.expectedEntry;
	assert.equal(
		validateProfileAdmissionRequest({
			...entry,
			step: { ...entry.step, expectedEntry: withoutFileIdentity },
		}),
		false,
	);
	assert.equal(
		validateProfileAdmissionResponse({
			type: "sourceSnapshotVerification",
			result: {
				type: "matched",
				verificationCursor: "next-cursor",
				nextIndex: "1",
			},
		}),
		true,
	);
});

test("Reset scopes are closed and independent of old Account payloads", () => {
	const scope = {
		version: 1,
		format: "desktopLegacyV1",
		profileIdentity: "profile-object",
		families: [
			{
				family: "desktopStore",
				namespaceIdentity: "store-location",
				selectorPlanVersion: 1,
				file: { type: "present", fileIdentity: "file-object" },
			},
			{
				family: "desktopSyncStore",
				namespaceIdentity: "sync-location",
				selectorPlanVersion: 1,
				file: { type: "absent" },
			},
			{
				family: "desktopCredentials",
				namespaceIdentity: "credential-entry",
				selectorPlanVersion: 1,
				file: { type: "notFile" },
			},
		],
	};
	const initial = {
		type: "prepareLegacyProfileReset",
		wipeId: "wipe-id",
		format: "desktopLegacyV1",
		expectedScope: null,
	};
	assert.equal(validateProfileAdmissionRequest(initial), true);
	assert.equal(
		validateProfileAdmissionRequest({ ...initial, expectedScope: scope }),
		true,
	);
	const { expectedScope: _scope, ...missing } = initial;
	assert.equal(validateProfileAdmissionRequest(missing), false);
	for (const invalidScope of [
		{ ...scope, version: 2 },
		{ ...scope, families: scope.families.slice(1) },
		{
			...scope,
			families: [
				{ ...scope.families[0], file: ["present", "file-object"] },
				...scope.families.slice(1),
			],
		},
	]) {
		assert.equal(
			validateProfileAdmissionRequest({
				...initial,
				expectedScope: invalidScope,
			}),
			false,
		);
	}
	assert.equal(
		validateProfileAdmissionResponse({
			type: "profileResetPrepared",
			result: {
				type: "prepared",
				snapshot: { resetHandle: "reset-handle", wipeId: "wipe-id", scope },
			},
		}),
		true,
	);
	assert.equal(
		validateProfileAdmissionRequest({
			type: "resetLegacySourceFamily",
			resetHandle: "reset-handle",
			wipeId: "wipe-id",
			family: "desktopCredentials",
		}),
		true,
	);
	assert.equal(
		validateProfileAdmissionResponse({
			type: "profileResetFamilyResult",
			resetHandle: "reset-handle",
			wipeId: "wipe-id",
			family: "desktopCredentials",
			result: { type: "alreadyAbsent" },
		}),
		true,
	);
});
