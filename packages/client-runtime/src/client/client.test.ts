import { describe, expect, test } from "bun:test";
import { createFakeRuntimeTransport } from "../testing";
import {
	createRuntimeClient,
	decodeOutcome,
	RuntimeRequestError,
} from "./index";

describe("Runtime client requests", () => {
	test("Team leave recovery lists Core-retained original start Operations", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });
		const reading = client.listTeamLeaveAttempts({ accountId: "same-account" });
		await transport.settled();
		expect(transport.pendingRequests()[0]?.request).toEqual({
			type: "listTeamLeaveAttempts",
			accountId: "same-account",
		});
		transport.answer({
			type: "succeeded",
			value: {
				type: "teamLeaveAttempts",
				attempts: [{ teamId: "old-team", startOperationId: "original-start" }],
			},
		});
		expect(await reading).toEqual([
			{ teamId: "old-team", startOperationId: "original-start" },
		]);
		const acknowledging = client.acknowledgeTeamLeaveAttempt({
			accountId: "same-account",
			startOperationId: "original-start",
		});
		await transport.settled();
		expect(transport.pendingRequests()[0]?.request).toEqual({
			type: "acknowledgeTeamLeaveAttempt",
			accountId: "same-account",
			startOperationId: "original-start",
		});
		transport.answer({
			type: "succeeded",
			value: { type: "teamLeaveAttemptAcknowledged" },
		});
		await acknowledging;
		await client.close();
	});
	test("Rotation facade carries closed Account-scoped selection and retained identities", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });
		const input = {
			accountId: "account-1",
			intent: { type: "teamLeave" as const, teamId: "team-1" },
		};
		const preparing = client.prepareRotation(input);
		await transport.settled();
		expect(transport.pendingRequests()[0]?.request).toEqual({
			type: "prepareRotation",
			...input,
		});
		const selection = {
			accountId: input.accountId,
			authorityGenerationId: "generation-1",
			incarnationId: "incarnation-1",
			intent: input.intent,
			lockEpoch: "epoch-1",
			plans: [],
			candidates: [],
			startOperationId: "start-1",
		};
		transport.answer({
			type: "succeeded",
			value: { type: "rotationPrepared", selection },
		});
		expect(await preparing).toEqual({ type: "rotationPrepared", selection });

		const completing = client.completeRotation({
			accountId: input.accountId,
			selection,
		});
		await transport.settled();
		expect(transport.pendingRequests()[0]?.request).toEqual({
			type: "completeRotation",
			accountId: input.accountId,
			selection,
		});
		transport.answer({
			type: "succeeded",
			value: {
				type: "rotationFinalizePending",
				finalizeOperationId: "finalize-1",
			},
		});
		expect(await completing).toEqual({
			type: "rotationFinalizePending",
			finalizeOperationId: "finalize-1",
		});

		const inspecting = client.inspectRotation({
			accountId: input.accountId,
			startOperationId: selection.startOperationId,
		});
		await transport.settled();
		expect(transport.pendingRequests()[0]?.request).toEqual({
			type: "inspectRotation",
			accountId: input.accountId,
			startOperationId: "start-1",
		});
		transport.answer({
			type: "succeeded",
			value: { type: "rotationCompleted", personalTeamId: "team-2" },
		});
		expect(await inspecting).toEqual({
			type: "rotationCompleted",
			personalTeamId: "team-2",
		});
		await client.close();
	});

	test("current-User Invitation calls stay Account scoped and preserve ambiguous acceptance", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });
		const listing = client.listMyTeamInvitations({ accountId: "account-1" });
		await transport.settled();
		expect(transport.pendingRequests()[0]?.request).toEqual({
			type: "listMyTeamInvitations",
			accountId: "account-1",
		});
		transport.answer({
			type: "succeeded",
			value: {
				type: "myTeamInvitations",
				invitations: [
					{
						id: "invitation-1",
						teamId: "team-2",
						teamName: "Inviting Team",
						role: "member",
						invitedBy: "Alex",
						expiresAt: "2099-01-01T00:00:00Z",
					},
				],
			},
		});
		expect((await listing)[0]?.teamId).toBe("team-2");

		const accepting = client.acceptMyTeamInvitation({
			accountId: "account-1",
			invitationId: "invitation-1",
		});
		await transport.settled();
		expect(transport.pendingRequests()[0]?.request).toEqual({
			type: "acceptMyTeamInvitation",
			accountId: "account-1",
			invitationId: "invitation-1",
		});
		transport.answer({
			type: "succeeded",
			value: {
				type: "myTeamInvitationUncertain",
				action: "accept",
				invitationId: "invitation-1",
				pending: false,
				currentTeamId: "team-2",
			},
		});
		expect(await accepting).toMatchObject({
			type: "myTeamInvitationUncertain",
			currentTeamId: "team-2",
		});
		await client.close();
	});

	test("Invitation facade forwards only closed Account-scoped commands and preserves uncertainty", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });
		const creating = client.createTeamInvitation({
			accountId: "account-1",
			teamId: "team-1",
			email: "invitee@example.test",
			role: "member",
		});
		await transport.settled();
		expect(transport.pendingRequests()[0]?.request).toEqual({
			type: "createTeamInvitation",
			accountId: "account-1",
			teamId: "team-1",
			email: "invitee@example.test",
			role: "member",
		});
		transport.answer({
			type: "succeeded",
			value: {
				type: "teamInvitationUncertain",
				phase: "firstSend",
				originalInvitationId: null,
			},
		});
		expect(await creating).toEqual({
			type: "teamInvitationUncertain",
			phase: "firstSend",
			originalInvitationId: null,
		});
		expect(transport.pendingRequests()).toHaveLength(0);
		expect(
			decodeOutcome(
				JSON.stringify({
					type: "succeeded",
					value: {
						type: "teamInvitationCreated",
						invitationId: "invitation-1",
						token: "one-time-token",
						candidate: null,
						continuationId: null,
					},
				}),
			),
		).toMatchObject({
			type: "teamInvitationCreated",
			token: "one-time-token",
		});
		await client.close();
	});

	test("admin Invitation actions preserve confirmed and lost one-time-token results", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });
		const input = {
			accountId: "account-1",
			teamId: "team-1",
			invitationId: "invitation-1",
		};
		const resending = client.resendTeamInvitation(input);
		await transport.settled();
		expect(transport.pendingRequests()[0]?.request).toEqual({
			type: "resendTeamInvitation",
			...input,
		});
		transport.answer({
			type: "succeeded",
			value: {
				type: "teamInvitationResent",
				invitationId: "invitation-1",
				token: "rotated-once-token",
			},
		});
		expect(await resending).toMatchObject({ token: "rotated-once-token" });

		const cancelling = client.cancelTeamInvitation(input);
		await transport.settled();
		expect(transport.pendingRequests()[0]?.request).toEqual({
			type: "cancelTeamInvitation",
			...input,
		});
		transport.answer({
			type: "succeeded",
			value: {
				type: "teamInvitationAdminUncertain",
				action: "cancel",
				invitationId: "invitation-1",
				pending: null,
			},
		});
		expect(await cancelling).toMatchObject({
			type: "teamInvitationAdminUncertain",
			pending: null,
		});
		await client.close();
	});

	test("Team-page read is Account scoped and preserves typed Server failures", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });
		const pending = client.readTeamPage({ accountId: "account-2" });
		await transport.settled();
		expect(transport.pendingRequests().map(({ request }) => request)).toEqual([
			{ type: "readTeamPage", accountId: "account-2" },
		]);
		transport.answer({
			type: "succeeded",
			value: {
				type: "teamPage",
				page: {
					user: { id: "user-2", name: "User Two", email: "two@example.test" },
					team: null,
					members: [],
					invitations: [],
					teamManagementEnabled: false,
				},
			},
		});
		expect((await pending).user.id).toBe("user-2");
		const problem = {
			status: 403,
			code: "forbidden",
			message: "Team read refused",
			requestId: "request-1",
			retryable: false,
			retryAfterSeconds: null,
			fieldErrors: [],
		};
		try {
			decodeOutcome(
				JSON.stringify({
					type: "failed",
					value: {
						code: "ACCESS_DENIED",
						message: "Team read refused",
						teamPageProblem: problem,
					},
				}),
			);
			throw new Error("expected failure");
		} catch (error) {
			expect(error).toBeInstanceOf(RuntimeRequestError);
			expect(error).toMatchObject({
				code: "ACCESS_DENIED",
				teamPageProblem: problem,
			});
		}
	});
	test("Share management uses only closed Account-scoped requests and returns foreground results", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });
		const history = client.listItemShareLinks({
			accountId: "account-2",
			itemId: "item-1",
		});
		const logs = client.listShareAccessLogs({
			accountId: "account-2",
			itemId: "item-1",
			linkId: "link-1",
		});
		const revoked = client.revokeShareLink({
			accountId: "account-2",
			itemId: "item-1",
			linkId: "link-1",
		});
		await transport.settled();
		expect(transport.pendingRequests().map(({ request }) => request)).toEqual([
			{ type: "listItemShareLinks", accountId: "account-2", itemId: "item-1" },
			{
				type: "listShareAccessLogs",
				accountId: "account-2",
				itemId: "item-1",
				linkId: "link-1",
			},
			{
				type: "revokeShareLink",
				accountId: "account-2",
				itemId: "item-1",
				linkId: "link-1",
			},
		]);
		transport.answer({
			type: "succeeded",
			value: {
				type: "itemShareLinks",
				accountId: "account-2",
				itemId: "item-1",
				links: [],
				baseShareUrl: "https://example.test/share",
			},
		});
		transport.answer({
			type: "succeeded",
			value: {
				type: "shareAccessLogs",
				accountId: "account-2",
				linkId: "link-1",
				logs: [],
			},
		});
		transport.answer({
			type: "succeeded",
			value: {
				type: "shareLinkRevoked",
				accountId: "account-2",
				linkId: "link-1",
			},
		});
		expect(await history).toEqual({
			accountId: "account-2",
			itemId: "item-1",
			links: [],
			baseShareUrl: "https://example.test/share",
		});
		expect(await logs).toEqual({
			accountId: "account-2",
			linkId: "link-1",
			logs: [],
		});
		expect(await revoked).toEqual({ accountId: "account-2", linkId: "link-1" });
	});

	test("routes every closed Item category through the neutral client facade", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });
		const drafts = [
			{ category: "login", data: { title: "Login" } },
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
			{ category: "identity", data: { title: "Identity" } },
			{
				category: "authenticator",
				data: {
					title: "Authenticator",
					totpSecret: "secret",
					linkedItemId: "login-1",
				},
			},
		] as const;
		const pending = drafts.map((draft) =>
			client.createItem({ accountId: "account-1", vaultId: "vault-1", draft }),
		);
		await transport.settled();
		expect(transport.pendingRequests().map(({ request }) => request)).toEqual(
			drafts.map((draft) => ({
				type: "createItem",
				accountId: "account-1",
				vaultId: "vault-1",
				draft,
			})),
		);
		for (let index = 0; index < drafts.length; index += 1) {
			transport.answer({
				type: "succeeded",
				value: {
					type: "accepted",
					operationId: `operation-${index}`,
					itemId: `item-${index}`,
					replicaRevision: String(index),
				},
			});
		}
		await Promise.all(pending);
	});

	test("routes every ordinary Item mutation through its generated Runtime request", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });
		const guard = {
			accountId: "account-1",
			incarnation: "incarnation-1",
			lockEpoch: "0",
			itemId: "item-1",
			vaultId: "vault-1",
			itemVersion: 1,
		};
		const mutations = [
			client.updateItem({
				accountId: "account-1",
				itemId: "item-1",
				guard,
				draft: { category: "login", data: { title: "Updated" } },
			}),
			client.setItemFavorite({
				accountId: "account-1",
				itemId: "item-1",
				favorite: true,
			}),
			client.trashItem({ accountId: "account-1", itemId: "item-1" }),
			client.restoreItem({ accountId: "account-1", itemId: "item-1" }),
			client.moveItem({
				accountId: "account-1",
				itemId: "item-1",
				targetVaultId: "vault-2",
			}),
			client.permanentlyDeleteItem({
				accountId: "account-1",
				itemId: "item-1",
			}),
		];
		await transport.settled();

		expect(transport.pendingRequests().map(({ request }) => request)).toEqual([
			{
				type: "updateItem",
				accountId: "account-1",
				itemId: "item-1",
				guard,
				draft: { category: "login", data: { title: "Updated" } },
			},
			{
				type: "setItemFavorite",
				accountId: "account-1",
				itemId: "item-1",
				favorite: true,
			},
			{ type: "trashItem", accountId: "account-1", itemId: "item-1" },
			{ type: "restoreItem", accountId: "account-1", itemId: "item-1" },
			{
				type: "moveItem",
				accountId: "account-1",
				itemId: "item-1",
				targetVaultId: "vault-2",
			},
			{
				type: "permanentlyDeleteItem",
				accountId: "account-1",
				itemId: "item-1",
			},
		]);

		for (let index = 0; index < mutations.length; index += 1) {
			transport.answer({
				type: "succeeded",
				value: {
					type: "accepted",
					operationId: `operation-${index}`,
					itemId: "item-1",
					replicaRevision: String(index),
				},
			});
		}
		await Promise.all(mutations);
	});

	test("forwards semantic credential removal and private Item duplication with selection guards", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });
		const editGuard = {
			accountId: "account-1",
			incarnation: "incarnation-1",
			lockEpoch: "3",
			itemId: "item-1",
			vaultId: "vault-1",
			itemVersion: 2,
		};
		const duplicateGuard = {
			accountId: "account-1",
			incarnationId: "incarnation-1",
			lockEpoch: "3",
			sourceItemId: "item-1",
			vaultId: "vault-1",
			replicaRevision: "8",
			source: { type: "authoritative" as const, itemVersion: 2 },
		};
		const removing = client.removePasskey({
			accountId: "account-1",
			itemId: "item-1",
			guard: editGuard,
			rpId: "example.test",
			credentialId: "credential-1",
			publicKeyFingerprint: "a".repeat(64),
		});
		const duplicating = client.duplicateItem({
			accountId: "account-1",
			sourceItemId: "item-1",
			sourceGuard: duplicateGuard,
			title: "Copy",
		});
		await transport.settled();
		expect(transport.pendingRequests().map(({ request }) => request)).toEqual([
			{
				type: "removePasskey",
				accountId: "account-1",
				itemId: "item-1",
				guard: editGuard,
				rpId: "example.test",
				credentialId: "credential-1",
				publicKeyFingerprint: "a".repeat(64),
			},
			{
				type: "duplicateItem",
				accountId: "account-1",
				sourceItemId: "item-1",
				sourceGuard: duplicateGuard,
				title: "Copy",
			},
		]);
		for (const itemId of ["item-1", "item-copy"]) {
			transport.answer({
				type: "succeeded",
				value: {
					type: "accepted",
					operationId: `operation-${itemId}`,
					itemId,
					replicaRevision: "9",
				},
			});
		}
		expect((await removing).itemId).toBe("item-1");
		expect((await duplicating).itemId).toBe("item-copy");
	});

	test("routes foreground Attachment work through the closed Runtime requests", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });
		const requests = [
			client.renameAttachment({
				accountId: "account-1",
				attachmentId: "attachment-1",
				name: "renamed.txt",
			}),
			client.deleteAttachment({
				accountId: "account-1",
				attachmentId: "attachment-1",
			}),
			client.downloadAttachment({
				accountId: "account-1",
				attachmentId: "attachment-1",
				sinkCapabilityId: "sink-1",
			}),
			client.uploadAttachment({
				accountId: "account-1",
				itemId: "item-1",
				name: "upload.txt",
				contentType: "text/plain",
				fileSize: "12",
				sourceCapabilityId: "source-1",
			}),
		];
		await transport.settled();

		expect(transport.pendingRequests().map(({ request }) => request)).toEqual([
			{
				type: "renameAttachment",
				accountId: "account-1",
				attachmentId: "attachment-1",
				name: "renamed.txt",
			},
			{
				type: "deleteAttachment",
				accountId: "account-1",
				attachmentId: "attachment-1",
			},
			{
				type: "downloadAttachment",
				accountId: "account-1",
				attachmentId: "attachment-1",
				sinkCapabilityId: "sink-1",
			},
			{
				type: "uploadAttachment",
				accountId: "account-1",
				itemId: "item-1",
				name: "upload.txt",
				contentType: "text/plain",
				fileSize: "12",
				sourceCapabilityId: "source-1",
			},
		]);

		transport.answer({
			type: "succeeded",
			value: {
				type: "attachmentRenamed",
				accountId: "account-1",
				attachmentId: "attachment-1",
			},
		});
		transport.answer({
			type: "succeeded",
			value: {
				type: "attachmentDeleted",
				accountId: "account-1",
				attachmentId: "attachment-1",
			},
		});
		transport.answer({
			type: "succeeded",
			value: {
				type: "attachmentDownloaded",
				accountId: "account-1",
				attachmentId: "attachment-1",
			},
		});
		transport.answer({
			type: "succeeded",
			value: {
				type: "attachmentUploaded",
				attachmentId: "attachment-2",
				replicaRevision: "9",
			},
		});

		expect(await Promise.all(requests)).toEqual([
			{ accountId: "account-1", attachmentId: "attachment-1" },
			{ accountId: "account-1", attachmentId: "attachment-1" },
			{ accountId: "account-1", attachmentId: "attachment-1" },
			{ attachmentId: "attachment-2", replicaRevision: "9" },
		]);
	});
	test("signs in over the generated request and response shapes", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });

		const signingIn = client.signIn({
			serverUrl: "https://server.test",
			email: "a@b.test",
			masterPassword: "password",
			secretKey: "secret",
			insecureTransportConfirmed: false,
		});
		await transport.settled();
		const [pending] = transport.pendingRequests();
		expect(pending?.request).toEqual({
			type: "signIn",
			serverUrl: "https://server.test",
			email: "a@b.test",
			masterPassword: "password",
			secretKey: "secret",
			insecureTransportConfirmed: false,
		});

		transport.answer({
			type: "succeeded",
			value: { type: "signedIn", accountId: "account-1", userId: "user-1" },
		});
		expect(await signingIn).toEqual({
			accountId: "account-1",
			userId: "user-1",
		});
	});

	test("mints a distinct request id per request", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });

		void client.quickUnlock({ accountId: "account-1", masterPassword: "a" });
		void client.quickUnlock({ accountId: "account-1", masterPassword: "b" });
		await transport.settled();

		const ids = transport.pendingRequests().map((entry) => entry.requestId);
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
	});

	test("throws a typed error that carries the code and withholds the Rust message", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });

		const unlocking = client.quickUnlock({
			accountId: "account-1",
			masterPassword: "wrong",
		});
		await transport.settled();
		transport.answer({
			type: "failed",
			value: {
				code: "AUTHENTICATION_REQUIRED",
				message: "srp verifier mismatch at replica.rs:214",
			},
		});

		const error = await unlocking.catch((thrown: unknown) => thrown);
		expect(error).toBeInstanceOf(RuntimeRequestError);
		const failure = error as RuntimeRequestError;
		expect(failure.code).toBe("AUTHENTICATION_REQUIRED");
		expect(failure.message).not.toContain("srp verifier mismatch");
		expect(failure.detail).toBe("srp verifier mismatch at replica.rs:214");
	});

	test("recovery resource failure preserves its typed bound without exposing diagnostic text", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });
		const exporting = client.exportAccountRecovery({
			accountId: "account-1",
			password: "separate",
			sinkCapabilityId: "sink",
		});
		await transport.settled();
		transport.answer({
			type: "failed",
			value: {
				code: "SIZE_REJECTED",
				recoveryBound: "archiveBytes",
				message: "private raw detail",
			},
		});
		const failure = (await exporting.catch(
			(error: unknown) => error,
		)) as RuntimeRequestError;
		expect(failure.code).toBe("SIZE_REJECTED");
		expect(failure.recoveryBound).toBe("archiveBytes");
		expect(failure.message).not.toContain("private raw detail");
		await client.close();
	});

	test("rejects a response of the wrong variant instead of returning it", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });

		const creating = client.createItem({
			accountId: "account-1",
			vaultId: "vault-1",
			draft: { category: "login", data: { title: "Bank" } },
		});
		await transport.settled();
		transport.answer({
			type: "succeeded",
			value: { type: "signedIn", accountId: "account-1", userId: "user-1" },
		});

		const error = await creating.catch((thrown: unknown) => thrown);
		expect(error).toBeInstanceOf(RuntimeRequestError);
		expect((error as RuntimeRequestError).code).toBe("INVARIANT_VIOLATION");
	});

	test("accepts a created Login Item", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });

		const creating = client.createItem({
			accountId: "account-1",
			vaultId: "vault-1",
			draft: { category: "login", data: { title: "Bank", username: "me" } },
		});
		await transport.settled();
		transport.answer({
			type: "succeeded",
			value: {
				type: "accepted",
				operationId: "operation-1",
				itemId: "item-1",
				replicaRevision: "7",
			},
		});

		expect(await creating).toEqual({
			operationId: "operation-1",
			itemId: "item-1",
			replicaRevision: "7",
		});
	});

	test("keeps Share creation and delivery acknowledgement explicitly Account-scoped", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });

		const creating = client.createShare({
			accountId: "account-share",
			itemId: "item-share",
			draft: {
				accessMode: "anyone",
				expiresIn: "7days",
				isOneTimeUse: false,
			},
		});
		await transport.settled();
		expect(transport.pendingRequests()[0]?.request).toEqual({
			type: "createShare",
			accountId: "account-share",
			itemId: "item-share",
			draft: {
				accessMode: "anyone",
				expiresIn: "7days",
				isOneTimeUse: false,
			},
		});
		transport.answer({
			type: "succeeded",
			value: {
				type: "accepted",
				operationId: "operation-share",
				itemId: "item-share",
				replicaRevision: "8",
			},
		});
		expect(await creating).toEqual({
			operationId: "operation-share",
			itemId: "item-share",
			replicaRevision: "8",
		});

		const acknowledging = client.acknowledgeShareResult({
			accountId: "account-share",
			operationId: "operation-share",
		});
		await transport.settled();
		expect(transport.pendingRequests()[0]?.request).toEqual({
			type: "acknowledgeShareResult",
			accountId: "account-share",
			operationId: "operation-share",
		});
		transport.answer({
			type: "succeeded",
			value: {
				type: "shareResultAcknowledged",
				accountId: "account-share",
				operationId: "operation-share",
			},
		});
		expect(await acknowledging).toEqual({
			accountId: "account-share",
			operationId: "operation-share",
		});
	});

	test("forwards the closed create-Vault request and exposes one shared writable catalog", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });
		const store = client.writableVaults();
		const sameStore = client.writableVaults();
		expect(sameStore).toBe(store);

		const creating = client.createVault({
			accountId: "account-1",
			name: "Shared secrets",
			vaultType: "shared",
			icon: "users",
			imageSource: null,
		});
		await transport.settled();
		expect(transport.pendingRequests()[0]?.request).toEqual({
			type: "createVault",
			accountId: "account-1",
			name: "Shared secrets",
			vaultType: "shared",
			icon: "users",
			imageSource: null,
		});
		transport.answer({
			type: "succeeded",
			value: {
				type: "vaultCreationAccepted",
				operationId: "operation-vault",
				vaultId: "vault-new",
				replicaRevision: "12",
			},
		});
		expect(await creating).toEqual({
			operationId: "operation-vault",
			vaultId: "vault-new",
			replicaRevision: "12",
		});
	});

	test("removes one named Account and answers the whole teardown outcome", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });

		const removing = client.removeAccount("account-1");
		await transport.settled();
		expect(transport.pendingRequests()[0]?.request).toEqual({
			type: "removeAccount",
			accountId: "account-1",
		});

		transport.answer({
			type: "succeeded",
			// The Runtime omits an empty phase list on the wire.
			value: {
				type: "teardown",
				scope: { type: "account", accountId: "account-1" },
				status: "complete",
			},
		});
		expect(await removing).toEqual({
			scope: { type: "account", accountId: "account-1" },
			status: "complete",
			failures: [],
		});
	});

	test("deletes the named Server Account with caller-owned exact retry material", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });

		const deleting = client.deleteServerAccount({
			accountId: "account-1",
			confirmEmail: "person@example.test",
			requestId: "018f47a2-6f40-47da-8d53-a55e557dc723",
		});
		await transport.settled();
		expect(transport.pendingRequests()[0]?.request).toEqual({
			type: "deleteServerAccount",
			accountId: "account-1",
			confirmEmail: "person@example.test",
			requestId: "018f47a2-6f40-47da-8d53-a55e557dc723",
		});

		transport.answer({
			type: "succeeded",
			value: {
				type: "serverAccountDeletion",
				accountId: "account-1",
				requestId: "018f47a2-6f40-47da-8d53-a55e557dc723",
				outcome: "deleted",
			},
		});
		expect(await deleting).toEqual({
			accountId: "account-1",
			requestId: "018f47a2-6f40-47da-8d53-a55e557dc723",
			outcome: "deleted",
		});
	});

	test("keeps an incomplete teardown renderable and retryable instead of collapsing it", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });

		const wiping = client.wipe();
		await transport.settled();
		expect(transport.pendingRequests()[0]?.request).toEqual({ type: "wipe" });

		transport.answer({
			type: "succeeded",
			value: {
				type: "teardown",
				scope: { type: "device" },
				status: "incomplete",
				failures: ["hostCleanup", "replica"],
			},
		});
		expect(await wiping).toEqual({
			scope: { type: "device" },
			status: "incomplete",
			failures: ["hostCleanup", "replica"],
		});
	});

	test("closes the transport", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });
		await client.close();
		expect(transport.calls.map((call) => call.type)).toEqual(["close"]);
	});

	test("routes one ordered Import batch through the neutral client facade", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });
		const importing = client.importItems({
			accountId: "account-1",
			vaultId: "vault-1",
			items: [
				{
					draft: { category: "login", data: { title: "Imported Login" } },
					favorite: true,
				},
				{
					draft: {
						category: "secure-note",
						data: { title: "Imported Note", note: "Body" },
					},
					favorite: false,
				},
			],
		});
		await transport.settled();
		// The host hands over plaintext drafts and Favorite only. Rust owns every Item identity.
		expect(transport.pendingRequests()[0]?.request).toEqual({
			type: "importItems",
			accountId: "account-1",
			vaultId: "vault-1",
			items: [
				{
					draft: { category: "login", data: { title: "Imported Login" } },
					favorite: true,
				},
				{
					draft: {
						category: "secure-note",
						data: { title: "Imported Note", note: "Body" },
					},
					favorite: false,
				},
			],
		});

		transport.answer({
			type: "succeeded",
			value: {
				type: "importBatchAccepted",
				operationId: "operation-import-1",
				vaultId: "vault-1",
				itemIds: ["item-1", "item-2"],
				replicaRevision: "7",
			},
		});
		expect(await importing).toEqual({
			operationId: "operation-import-1",
			vaultId: "vault-1",
			itemIds: ["item-1", "item-2"],
			replicaRevision: "7",
		});
	});

	test("refuses an Import answer that is not the accepted batch", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });
		const importing = client.importItems({
			accountId: "account-1",
			vaultId: "vault-1",
			items: [],
		});
		await transport.settled();
		transport.answer({
			type: "succeeded",
			value: {
				type: "accepted",
				operationId: "operation-import-1",
				itemId: "item-1",
				replicaRevision: "7",
			},
		});
		await expect(importing).rejects.toBeInstanceOf(RuntimeRequestError);
	});
});
