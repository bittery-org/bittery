import { describe, expect, test } from "bun:test";
import { createFakeRuntimeTransport } from "../testing";
import { createRuntimeClient, RuntimeRequestError } from "./index";

describe("Runtime client requests", () => {
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

		const creating = client.createLoginItem({
			accountId: "account-1",
			vaultId: "vault-1",
			draft: { title: "Bank" },
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

		const creating = client.createLoginItem({
			accountId: "account-1",
			vaultId: "vault-1",
			draft: { title: "Bank", username: "me" },
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

	test("closes the transport", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });
		await client.close();
		expect(transport.calls.map((call) => call.type)).toEqual(["close"]);
	});
});
