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

test("generated Operations projections distinguish local legacy holds from Server results", () => {
	const projection = (resolution) => ({
		type: "operations",
		value: {
			accountId: "account",
			replicaRevision: "1",
			operations: [
				{
					operationId: "original-create",
					kind: "createItem",
					attemptCount: "5",
					nextAttemptAtMs: null,
					resolution,
					importedCount: null,
					rejectionCode: null,
				},
			],
		},
	});
	for (const resolution of [
		"legacyFailed",
		"legacyConflicted",
		"pending",
		"applied",
		"rejected",
	]) {
		assert.equal(
			validateRuntimeProjection(projection(resolution)),
			true,
			resolution,
		);
	}
	assert.equal(validateRuntimeProjection(projection("failed")), false);
});

test("generated Operations validator accepts the parked missing-source projection", () => {
	const projection = (reason) => ({
		type: "operations",
		value: {
			accountId: "source-account",
			replicaRevision: "1",
			operations: [
				{
					operationId: "original-move",
					kind: "moveItem",
					attemptCount: "0",
					nextAttemptAtMs: null,
					resolution: "pending",
					importedCount: null,
					rejectionCode: null,
					crossAccountMove: {
						phase: { type: "targetCreate" },
						destinationServerUrl: "https://target.invalid",
						destinationUserId: "target-user",
						destinationVaultId: "target-vault",
						sourceVisible: false,
						disposition: { type: "blocked", reason },
					},
				},
			],
		},
	});
	assert.equal(
		validateRuntimeProjection(projection("missingSourceEvidence")),
		true,
	);
	assert.equal(
		validateRuntimeProjection(projection("missingSourceEvidnce")),
		false,
	);
});

test("Travel policy projections preserve an absent legacy receipt without making it optional", () => {
	const projection = (policy) => ({
		type: "travelMode",
		value: {
			accountId: "account",
			revision: "0",
			enforcement: "ready",
			lastVerifiedPolicy: policy,
		},
	});
	const policy = {
		enabled: false,
		hiddenVaultIds: [],
		serverEnabledAtMs: null,
		serverUpdatedAtMs: null,
		verifiedAtMs: null,
	};
	assert.equal(validateRuntimeProjection(projection(policy)), true);
	assert.equal(
		validateRuntimeProjection(
			projection({ ...policy, verifiedAtMs: "1700000000000" }),
		),
		true,
	);
	const { verifiedAtMs: _receipt, ...missing } = policy;
	assert.equal(validateRuntimeProjection(projection(missing)), false);
});

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
			type: "createItem",
			accountId: "account-1",
			vaultId: "vault-1",
			draft: { category: "login", data: { title: "Server" } },
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

test("generated Item validators preserve five closed categories and reject mixed fields", () => {
	const drafts = [
		{
			category: "login",
			data: { title: "Login", password: "secret", totpDigits: 8 },
		},
		{ category: "secure-note", data: { title: "Note", note: "Body" } },
		{
			category: "credit-card",
			data: {
				title: "Card",
				cardholderName: "Holder",
				cardNumber: "4111",
				cvv: "123",
				expiryDate: "12/30",
			},
		},
		{ category: "identity", data: { title: "Identity", firstName: "First" } },
		{
			category: "authenticator",
			data: {
				title: "Authenticator",
				totpSecret: "secret",
				linkedItemId: "login-1",
				totpDigits: 7,
			},
		},
	];
	for (const draft of drafts) {
		assert.equal(
			validateRuntimeRequest({
				type: "createItem",
				accountId: "account-1",
				vaultId: "vault-1",
				draft,
			}),
			true,
		);
	}
	assert.equal(
		validateRuntimeRequest({
			type: "createItem",
			accountId: "account-1",
			vaultId: "vault-1",
			draft: {
				category: "secure-note",
				data: { title: "Note", note: "Body", password: "mixed" },
			},
		}),
		false,
	);
	assert.equal(
		validateRuntimeRequest({
			type: "createItem",
			accountId: "account-1",
			vaultId: "vault-1",
			draft: {
				category: "login",
				data: {
					title: "Login",
					customFields: [
						{
							id: "field-1",
							label: "PIN",
							value: "1234",
							type: "password",
							foreignAuthority: "must-not-be-ignored",
						},
					],
				},
			},
		}),
		false,
	);
	assert.equal(
		validateRuntimeRequest({
			type: "createItem",
			accountId: "account-1",
			vaultId: "vault-1",
			draft: {
				category: "login",
				data: { title: "Login", cardNumber: "mixed" },
			},
		}),
		false,
	);
	assert.equal(
		validateRuntimeRequest({
			type: "createItem",
			accountId: "account-1",
			vaultId: "vault-1",
			draft: {
				category: "totp",
				data: { title: "Authenticator", totpSecret: "secret" },
			},
		}),
		false,
	);
	assert.equal(
		validateRuntimeRequest({
			type: "createItem",
			accountId: "account-1",
			vaultId: "vault-1",
			draft: {
				category: "authenticator",
				data: { title: "Authenticator", totpSecret: "secret", totpDigits: 9 },
			},
		}),
		false,
	);
});

test("generated Web Attachment Delete shapes are minimal and closed", () => {
	const request = {
		type: "deleteAttachment",
		accountId: "account-1",
		attachmentId: "attachment-1",
	};
	assert.equal(validateRuntimeRequest(request), true);
	assert.equal(
		validateRuntimeRequest({ ...request, storageKey: "private/storage-key" }),
		false,
	);
	assert.equal(
		validateRuntimeOutcome({
			type: "succeeded",
			value: {
				type: "attachmentDeleted",
				accountId: "account-1",
				attachmentId: "attachment-1",
			},
		}),
		true,
	);
	assert.equal(
		validateRuntimeOutcome({
			type: "succeeded",
			value: {
				type: "attachmentDeleted",
				accountId: "account-1",
				attachmentId: "attachment-1",
				name: "secret.txt",
			},
		}),
		false,
	);
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

test("Team results keep Server invitation statuses and problem codes closed", () => {
	const invitation = {
		id: "invitation-1",
		email: "member@example.test",
		role: "member",
		status: "pending",
		invitedBy: "owner-1",
		createdAt: "2026-01-01T00:00:00Z",
		expiresAt: "2026-01-08T00:00:00Z",
	};
	const success = {
		type: "succeeded",
		value: {
			type: "teamPage",
			page: {
				user: { id: "owner-1", name: "Owner", email: "owner@example.test" },
				team: null,
				members: [],
				invitations: [invitation],
				teamManagementEnabled: false,
			},
		},
	};
	assert.equal(validateRuntimeOutcome(success), true);
	assert.equal(
		validateRuntimeOutcome({
			...success,
			value: {
				...success.value,
				page: {
					...success.value.page,
					invitations: [{ ...invitation, status: "not-a-server-status" }],
				},
			},
		}),
		false,
	);

	const problem = {
		status: 403,
		code: "FORBIDDEN",
		message: "Team read refused",
		requestId: "request-403",
		retryable: false,
		retryAfterSeconds: null,
		fieldErrors: [],
	};
	const failure = {
		type: "failed",
		value: {
			code: "ACCESS_DENIED",
			message: "Team read refused",
			teamPageProblem: problem,
		},
	};
	assert.equal(validateRuntimeOutcome(failure), true);
	assert.equal(
		validateRuntimeOutcome({
			...failure,
			value: {
				...failure.value,
				teamPageProblem: { ...problem, code: "NOT_A_SERVER_CODE" },
			},
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
						unlockCapabilities: {
							password: false,
							desktop: false,
							signIn: false,
						},
					},
				],
				closed: false,
			},
		}),
		true,
	);
});

test("Attachment Upload returns only its new identity and authoritative Replica revision", () => {
	assert.equal(
		validateRuntimeOutcome({
			type: "succeeded",
			value: {
				type: "attachmentUploaded",
				attachmentId: "attachment-1",
				replicaRevision: "42",
			},
		}),
		true,
	);
	for (const extra of [
		{ accountId: "account-1" },
		{ itemId: "item-1" },
		{ runtimeIncarnation: "runtime-1" },
	]) {
		assert.equal(
			validateRuntimeOutcome({
				type: "succeeded",
				value: {
					type: "attachmentUploaded",
					attachmentId: "attachment-1",
					replicaRevision: "42",
					...extra,
				},
			}),
			false,
		);
	}
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
		data: {
			category: "login",
			data: {
				title: "Server",
				customFields: [
					{ id: "field-1", label: "PIN", value: "1234", type: "password" },
				],
				tags: ["work"],
			},
		},
		favorite: false,
		deletedAt: "2026-01-02T00:00:00Z",
		attachments: [
			{
				accountId: "account-1",
				attachmentId: "attachment-1",
				itemId: "item-1",
				vaultId: "vault-1",
				storageKey: "attachments/item-1/file.enc",
				name: "manual.txt",
				contentType: "text/plain",
				fileSize: 42,
				uploadedBy: "user-1",
				createdAt: "2026-01-01T00:00:00Z",
			},
		],
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
				data: {
					...item.data,
					data: {
						...item.data.data,
						customFields: [
							{ id: "field-1", label: "PIN", value: "1234", type: "pin" },
						],
					},
				},
			}),
		),
		false,
	);
});

test("Share result delivery and acknowledgement stay explicit and closed", () => {
	assert.equal(
		validateObservationRequest({
			type: "pendingShareResults",
			accountId: "account-1",
		}),
		true,
	);
	assert.equal(
		validateRuntimeProjection({
			type: "pendingShareResults",
			value: {
				accountId: "account-1",
				replicaRevision: "12",
				results: [
					{
						operationId: "operation-1",
						itemId: "item-1",
						shareLinkId: "share-link-1",
						shareUrl: "https://app.example.test/share/token#key",
						expiresAt: "2099-01-02T03:04:05Z",
					},
				],
			},
		}),
		true,
	);
	assert.equal(
		validateRuntimeRequest({
			type: "acknowledgeShareResult",
			accountId: "account-1",
			operationId: "operation-1",
		}),
		true,
	);
	assert.equal(
		validateRuntimeRequest({
			type: "acknowledgeShareResult",
			operationId: "operation-1",
		}),
		false,
	);
	assert.equal(
		validateRuntimeOutcome({
			type: "succeeded",
			value: {
				type: "shareResultAcknowledged",
				accountId: "account-1",
				operationId: "operation-1",
			},
		}),
		true,
	);
});

test("Attachment Download sink capability identity is canonical and bounded", () => {
	const request = (sinkCapabilityId) => ({
		type: "downloadAttachment",
		accountId: "account-1",
		attachmentId: "attachment-1",
		sinkCapabilityId,
	});
	assert.equal(validateRuntimeRequest(request("x")), true);
	assert.equal(validateRuntimeRequest(request("x".repeat(128))), true);
	assert.equal(validateRuntimeRequest(request("capability.A_z-9~")), true);
	assert.equal(validateRuntimeRequest(request("")), false);
	assert.equal(validateRuntimeRequest(request("x".repeat(129))), false);
	assert.equal(validateRuntimeRequest(request("not canonical")), false);
	assert.equal(validateRuntimeRequest(request("café")), false);
});

test("Attachment Upload carries bounded metadata and one opaque source capability", () => {
	const request = (overrides = {}) => ({
		type: "uploadAttachment",
		accountId: "account-1",
		itemId: "item-1",
		name: "report.txt",
		contentType: "text/plain",
		fileSize: "12",
		sourceCapabilityId: "source-1",
		...overrides,
	});
	assert.equal(validateRuntimeRequest(request()), true);
	assert.equal(
		validateRuntimeRequest(request({ sourceCapabilityId: "not canonical" })),
		false,
	);
	assert.equal(
		validateRuntimeRequest(request({ sourceCapabilityId: "x".repeat(129) })),
		false,
	);
	assert.equal(
		validateRuntimeRequest(request({ name: "x".repeat(256) })),
		false,
	);
	assert.equal(
		validateRuntimeRequest(request({ contentType: "x".repeat(256) })),
		false,
	);
	assert.equal(validateRuntimeRequest(request({ fileSize: 12 })), false);
	assert.equal(
		validateRuntimeRequest(request({ storageKey: "forbidden" })),
		false,
	);
});

test("teardown scope and partial failures stay explicit, closed, and redacted", () => {
	assert.equal(
		validateRuntimeRequest({ type: "removeAccount", accountId: "account-1" }),
		true,
	);
	assert.equal(
		validateRuntimeRequest({ type: "removeAccount", accountId: "" }),
		false,
	);
	assert.equal(validateRuntimeRequest({ type: "wipe" }), true);
	assert.equal(
		validateRuntimeRequest({ type: "wipe", accountId: "account-1" }),
		false,
	);

	const incomplete = {
		type: "succeeded",
		value: {
			type: "teardown",
			scope: { type: "account", accountId: "account-1" },
			status: "incomplete",
			failures: ["hostCleanup", "platformStorage"],
		},
	};
	assert.equal(validateRuntimeOutcome(incomplete), true);
	assert.equal(
		validateRuntimeOutcome({
			...incomplete,
			value: { ...incomplete.value, failures: ["hostCleanupFailedForever"] },
		}),
		false,
	);
	assert.equal(
		validateRuntimeOutcome({
			...incomplete,
			value: {
				...incomplete.value,
				failures: Array(5).fill("hostCleanup"),
			},
		}),
		false,
	);
	assert.equal(
		validateRuntimeOutcome({
			...incomplete,
			value: { ...incomplete.value, detail: "host exception" },
		}),
		false,
	);
	assert.equal(
		validateRuntimeOutcome({
			type: "succeeded",
			value: {
				type: "teardown",
				scope: { type: "device" },
				status: "complete",
			},
		}),
		true,
	);
});

test("Vault mutation bindings keep patches and image capabilities closed", () => {
	const scope = { accountId: "account-1", vaultId: "vault-1" };
	const update = {
		...scope,
		type: "updateVault",
		name: null,
		icon: { type: "unchanged" },
		image: { type: "unchanged" },
	};
	const source = {
		capabilityId: "source-1",
		byteLength: "42",
		contentType: "image/png",
	};
	for (const icon of [
		{ type: "unchanged" },
		{ type: "clear" },
		{ type: "set", value: "star" },
	]) {
		for (const image of [
			{ type: "unchanged" },
			{ type: "remove" },
			{ type: "source", source },
		]) {
			assert.equal(validateRuntimeRequest({ ...update, icon, image }), true);
		}
	}
	for (const image of [
		{ type: "remove", source },
		{ type: "source", source: { ...source, byteLength: 42 } },
		{ type: "source", source: { ...source, path: "/private/image.png" } },
		{
			type: "source",
			source: { ...source, uploadUrl: "https://objects.test/image" },
		},
	]) {
		assert.equal(validateRuntimeRequest({ ...update, image }), false);
	}
	assert.equal(
		validateRuntimeRequest({
			...update,
			icon: { type: "clear", value: "star" },
		}),
		false,
	);
	assert.equal(validateRuntimeRequest({ ...scope, type: "deleteVault" }), true);
	assert.equal(
		validateRuntimeRequest({
			...scope,
			type: "deleteVault",
			sessionToken: "token",
		}),
		false,
	);
	assert.equal(
		validateRuntimeRequest({ vaultId: "vault-1", type: "deleteVault" }),
		false,
	);
	for (const type of ["vaultUpdateAccepted", "vaultDeletionAccepted"]) {
		assert.equal(
			validateRuntimeOutcome({
				type: "succeeded",
				value: {
					type,
					operationId: "operation-1",
					vaultId: "vault-1",
					replicaRevision: "4",
				},
			}),
			true,
		);
	}
});

test("Share Link actions require their explicit parent Item", () => {
	for (const type of ["listShareAccessLogs", "revokeShareLink"]) {
		assert.equal(
			validateRuntimeRequest({ type, accountId: "account", linkId: "link" }),
			false,
		);
		assert.equal(
			validateRuntimeRequest({
				type,
				accountId: "account",
				itemId: "item",
				linkId: "link",
			}),
			true,
		);
	}
});

test("profile admission inspection and explicit Abort are closed startup controls", () => {
	assert.equal(
		validateRuntimeRequest({ type: "inspectProfileAdmission" }),
		true,
	);
	assert.equal(
		validateRuntimeRequest({
			type: "inspectProfileAdmission",
			accountId: "account",
		}),
		false,
	);
	assert.equal(
		validateRuntimeRequest({
			type: "abortProfileAdmission",
			admissionId: "fixed-admission",
		}),
		true,
	);
	for (const request of [
		{ type: "abortProfileAdmission" },
		{ type: "abortProfileAdmission", admissionId: null },
		{
			type: "abortProfileAdmission",
			admissionId: "fixed-admission",
			manifest: {},
		},
	])
		assert.equal(validateRuntimeRequest(request), false);
	const outcome = (state) => ({
		type: "succeeded",
		value: { type: "profileAdmissionInspection", state },
	});
	assert.equal(validateRuntimeOutcome(outcome({ type: "notStarted" })), true);
	for (const phase of [
		"preparing",
		"aborting",
		"aborted",
		"committed",
		"complete",
	])
		assert.equal(
			validateRuntimeOutcome(
				outcome({ type: "import", admissionId: "fixed-admission", phase }),
			),
			true,
		);
	for (const phase of ["wiping", "wiped"])
		assert.equal(
			validateRuntimeOutcome(
				outcome({ type: "reset", wipeId: "fixed-reset", phase }),
			),
			true,
		);
	for (const state of [
		{ type: "import", admissionId: "fixed-admission", phase: "future" },
		{
			type: "import",
			admissionId: "fixed-admission",
			phase: "preparing",
			manifest: {},
		},
		{ type: "reset", wipeId: "fixed-reset", phase: "preparing" },
		null,
		[],
	])
		assert.equal(validateRuntimeOutcome(outcome(state)), false);
	assert.equal(
		validateRuntimeOutcome({
			type: "succeeded",
			value: {
				type: "profileAdmissionAborted",
				admissionId: "fixed-admission",
			},
		}),
		true,
	);
});
