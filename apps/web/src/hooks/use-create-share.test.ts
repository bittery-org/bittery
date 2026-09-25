import { describe, expect, test } from "bun:test";
import { createRuntimeClient } from "@bittery/client-runtime/client";
import { createFakeRuntimeTransport } from "@bittery/client-runtime/testing";
import { createCoreContext } from "@bittery/core";
import type { AccountVaultRuntime } from "@bittery/core/services/account-vault-runtime";
import type { VaultCrypto } from "@bittery/core/services/vault-crypto";
import type { VaultRepository } from "@bittery/core/services/vault-repository";
import type { CryptoPort } from "@bittery/crypto-port";
import type { DecryptedItemWithContext } from "@bittery/shared/types";
import type { AccountStore, ItemCache } from "@bittery/storage";
import {
	createShareWithRuntime,
	waitForPendingShareResult,
} from "./use-create-share";

describe("Web Share creation ownership", () => {
	test("uses only Runtime creation and waits for its durable delivered result", async () => {
		const { transport, runtime, release } = await shareFixture();
		const transitionalCrypto = new Proxy({} as CryptoPort, {
			get: () => () => {
				throw new Error("transitional Share crypto was reached");
			},
		});
		const core = createCoreContext({
			storage: {
				getActiveAccount: async () => null,
			} as unknown as AccountStore,
			itemCache: {} as ItemCache,
			crypto: transitionalCrypto,
			vaultCrypto: {} as VaultCrypto,
			vaultRuntime: {
				repository: {} as VaultRepository,
				retry: async () => undefined,
			} as unknown as AccountVaultRuntime,
			commandQueue: { enqueue: async () => undefined },
		});
		expect("shares" in core).toBe(false);
		const creating = createShareWithRuntime(runtime, {
			item: {
				id: "item-1",
				accountId: "account-1",
			} as DecryptedItemWithContext,
			accessMode: "anyone",
			expiresIn: "7days",
			isOneTimeUse: false,
		});

		await transport.settled();
		const requests = transport.calls.filter((call) => call.type === "request");
		expect(requests).toHaveLength(1);
		expect(JSON.parse(requests[0]?.requestJson ?? "{}")).toEqual({
			type: "createShare",
			accountId: "account-1",
			itemId: "item-1",
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
				operationId: "operation-1",
				itemId: "item-1",
				replicaRevision: "4",
			},
		});
		await transport.settled();
		expect(
			transport.calls.filter((call) => call.type === "observe"),
		).toHaveLength(3);

		transport.publish({
			type: "pendingShareResults",
			value: {
				accountId: "account-1",
				replicaRevision: "5",
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
		});

		expect(await creating).toEqual({
			accountId: "account-1",
			operationId: "operation-1",
			itemId: "item-1",
			shareLinkId: "share-link-1",
			shareUrl: "https://app.example.test/share/token#key",
			expiresAt: "2099-01-02T03:04:05Z",
		});
		release();
		await runtime.close();
	});
});

async function shareFixture() {
	const transport = createFakeRuntimeTransport();
	const runtime = createRuntimeClient({ transport });
	const release = runtime.session().subscribe(() => {});
	await transport.settled();
	const publish = (
		access: "unlocked" | "locked" = "unlocked",
		accountId = "account-1",
	) => {
		transport.publish({
			type: "runtimeStatus",
			value: {
				accountId: null,
				closed: false,
				revision: "1",
				accounts: [
					{
						accountId,
						access,
						failure: null,
						replicaRevision: "1",
						unlockCapabilities: {
							password: false,
							desktop: false,
							signIn: false,
						},
						displayIdentity: {
							email: "test@example.test",
							name: "Test Account",
							teamName: null,
							teamAvatarUrl: null,
							serverUrl: "https://vault.example.test",
							secretKeyHint: "A3-A••••",
						},
					},
				],
			},
		});
		runtime.selectAccount(accountId);
	};
	publish();
	return { runtime, transport, publish, release };
}

test("a terminal Share rejection finishes the foreground waiter", async () => {
	const f = await shareFixture();
	const waiting = waitForPendingShareResult(f.runtime, "account-1", "rejected");
	const result = waiting.then(
		() => "unexpected success",
		(error: Error) => error.message,
	);
	await f.transport.settled();
	f.transport.publish({
		type: "operations",
		value: {
			accountId: "account-1",
			replicaRevision: "2",
			operations: [
				{
					operationId: "rejected",
					kind: "createShare",
					attemptCount: null,
					nextAttemptAtMs: null,
					resolution: "rejected",
					importedCount: null,
					rejectionCode: "vault_read_only",
				},
			],
		},
	});
	expect(
		await Promise.race([
			result,
			new Promise((resolve) => setTimeout(() => resolve("still waiting"), 30)),
		]),
	).toBe("Share Operation rejected: vault_read_only");
	f.release();
	await f.runtime.close();
});

for (const departure of ["lock", "account"] as const)
	test(`Share does not deliver across transient ${departure} departure`, async () => {
		const f = await shareFixture();
		const creating = createShareWithRuntime(f.runtime, {
			item: {
				id: "item-1",
				accountId: "account-1",
			} as DecryptedItemWithContext,
			accessMode: "anyone",
			expiresIn: "7days",
			isOneTimeUse: false,
		});
		const result = creating.then(
			() => "unexpected success",
			(error: Error) => error.name,
		);
		await f.transport.settled();
		f.transport.answer({
			type: "succeeded",
			value: {
				type: "accepted",
				operationId: "operation",
				itemId: "item-1",
				replicaRevision: "2",
			},
		});
		await f.transport.settled();
		if (departure === "lock") f.publish("locked");
		else f.publish("unlocked", "account-2");
		f.publish();
		f.transport.publish({
			type: "pendingShareResults",
			value: {
				accountId: "account-1",
				replicaRevision: "3",
				results: [
					{
						operationId: "operation",
						itemId: "item-1",
						shareLinkId: "share",
						shareUrl: "https://example.test/share#secret",
						expiresAt: "2099-01-01",
					},
				],
			},
		});
		expect(await result).toBe("AbortError");
		f.release();
		await f.runtime.close();
	});
