import { describe, expect, test } from "bun:test";
import { createFakeRuntimeTransport } from "../testing";
import { createRuntimeClient, RuntimeRequestError } from "./index";

describe("Runtime client requests", () => {
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
		const mutations = [
			client.updateItem({
				accountId: "account-1",
				itemId: "item-1",
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
