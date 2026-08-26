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
import { createShareWithRuntime } from "./use-create-share";

describe("Web Share creation ownership", () => {
	test("uses only Runtime creation and waits for its durable delivered result", async () => {
		const transport = createFakeRuntimeTransport();
		const runtime = createRuntimeClient({ transport });
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
		).toHaveLength(1);

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
		await runtime.close();
	});
});
