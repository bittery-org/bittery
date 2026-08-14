import { describe, expect, test } from "bun:test";
import { ApiError } from "@bittery/shared/api-client";
import type { ItemSyncCommand } from "@bittery/types";
import { CrossAccountItemCommandExecutor } from "./cross-account-item-command-executor";

const SOURCE = "account-source";
const TARGET = "account-target";

function notFound() {
	return new ApiError(
		{
			type: "test:not-found",
			title: "Not found",
			status: 404,
			code: "NOT_FOUND",
		},
		null,
	);
}

function command(overrides: Partial<ItemSyncCommand> = {}): ItemSyncCommand {
	return {
		id: "move-1",
		operationId: "move-1",
		type: "cross_account_move",
		accountId: SOURCE,
		accountEmail: "source@example.com",
		entityId: "item-source",
		vaultId: "vault-source",
		targetAccountId: TARGET,
		targetVaultId: "vault-target",
		targetItemId: "item-target",
		category: "login",
		encryptedPayload: {
			encryptedData: "ciphertext",
			encryptionIv: "iv",
			encryptionAlgorithm: "AES-GCM-AAD-V1",
			encryptionVersion: 1,
			encryptedByUserId: "user-target",
		},
		baseVersion: 1,
		timestamp: 1,
		retryCount: 0,
		...overrides,
	};
}

function targetItem(overrides: Record<string, unknown> = {}) {
	return {
		data: {
			vaultId: "vault-target",
			category: "login",
			encryptedData: "ciphertext",
			encryptionIv: "iv",
			encryptionAlgorithm: "AES-GCM-AAD-V1",
			...overrides,
		},
	};
}

function executor(clients: Record<string, unknown>) {
	return new CrossAccountItemCommandExecutor({
		crypto: { destroyKey: async () => undefined } as never,
		vaultCrypto: { getVaultKey: async () => ({ id: "target-key" }) } as never,
		getClientForAccount: async (accountId) => clients[accountId] as never,
	});
}

describe("CrossAccountItemCommandExecutor", () => {
	test("uses stable phase identities across create, trash, and delete", async () => {
		const phases: Array<[string, string | undefined]> = [];
		const service = executor({
			[TARGET]: {
				items: {
					get: async () => {
						throw notFound();
					},
					create: async (
						_v: string,
						_i: string,
						_p: unknown,
						options: { idempotencyKey?: string },
					) => phases.push(["create", options.idempotencyKey]),
				},
				attachments: { list: async () => ({ data: [] }) },
			},
			[SOURCE]: {
				items: {
					get: async () => ({ data: { version: 1, deletedAt: null } }),
					trash: async (_i: string, options: { idempotencyKey?: string }) =>
						phases.push(["trash", options.idempotencyKey]),
					deletePermanently: async (
						_i: string,
						options: { idempotencyKey?: string },
					) => phases.push(["delete", options.idempotencyKey]),
				},
				attachments: { list: async () => ({ data: [] }) },
			},
		});
		await expect(
			service.executeSemanticItemCommand(command()),
		).resolves.toEqual({ entityId: "item-source", etag: '"3"', version: 3 });
		expect(phases).toEqual([
			["create", "move-1:create-target"],
			["trash", "move-1:trash-source"],
			["delete", "move-1:delete-source"],
		]);
	});

	test("probes the deterministic target after a lost create response", async () => {
		let exists = false;
		let creates = 0;
		let deleted = false;
		const service = executor({
			[TARGET]: {
				items: {
					get: async () => {
						if (!exists) throw notFound();
						return targetItem();
					},
					create: async () => {
						creates++;
						exists = true;
						throw new Error("lost response");
					},
				},
				attachments: { list: async () => ({ data: [] }) },
			},
			[SOURCE]: {
				items: {
					get: async () => ({ data: { version: 1, deletedAt: null } }),
					trash: async () => undefined,
					deletePermanently: async () => {
						deleted = true;
					},
				},
				attachments: { list: async () => ({ data: [] }) },
			},
		});
		await expect(service.executeSemanticItemCommand(command())).rejects.toThrow(
			"lost response",
		);
		await service.executeSemanticItemCommand(command());
		expect({ creates, deleted }).toEqual({ creates: 1, deleted: true });
	});

	test("rejects a changed source before creating the target", async () => {
		let created = false;
		const service = executor({
			[TARGET]: {
				items: {
					get: async () => {
						throw notFound();
					},
					create: async () => {
						created = true;
					},
				},
			},
			[SOURCE]: {
				items: { get: async () => ({ data: { version: 2, deletedAt: null } }) },
			},
		});
		await expect(
			service.executeSemanticItemCommand(command()),
		).rejects.toMatchObject({ status: 412 });
		expect(created).toBe(false);
	});

	test("resolves attachment prerequisites by account id before creating the target", async () => {
		let created = false;
		const keyScopes: string[] = [];
		const destroyed: unknown[] = [];
		const sourceKey = { id: "source-key" };
		const service = new CrossAccountItemCommandExecutor({
			crypto: {
				destroyKey: async (key: unknown) => {
					destroyed.push(key);
				},
			} as never,
			vaultCrypto: {
				getVaultKey: async ({ accountId }: { accountId: string }) => {
					keyScopes.push(accountId);
					return accountId === SOURCE ? sourceKey : null;
				},
			} as never,
			getClientForAccount: async (accountId) =>
				({
					[SOURCE]: {
						items: {
							get: async () => ({ data: { version: 1, deletedAt: null } }),
						},
						attachments: {
							list: async () => ({ data: [{ id: "attachment-1" }] }),
						},
					},
					[TARGET]: {
						items: {
							get: async () => {
								throw notFound();
							},
							create: async () => {
								created = true;
							},
						},
					},
				})[accountId] as never,
		});

		await expect(
			service.executeSemanticItemCommand(
				command({
					accountEmail: "duplicate@example.com",
				}),
			),
		).rejects.toThrow("Cannot access target vault key");
		expect(created).toBe(false);
		expect(keyScopes).toEqual([SOURCE, TARGET]);
		expect(destroyed).toEqual([sourceKey]);
	});

	test("keeps the source when attachment download fails", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => ({ ok: false })) as never;
		let sourceDeleted = false;
		try {
			const service = executor({
				[TARGET]: {
					items: { get: async () => targetItem() },
					attachments: { list: async () => ({ data: [] }) },
				},
				[SOURCE]: {
					items: {
						get: async () => ({ data: { version: 1, deletedAt: null } }),
						trash: async () => {
							sourceDeleted = true;
						},
					},
					attachments: {
						list: async () => ({ data: [{ id: "attachment-1", fileSize: 4 }] }),
						createDownloadUrl: async () => ({
							data: { downloadUrl: "https://example.invalid" },
						}),
					},
				},
			});
			await expect(
				service.executeSemanticItemCommand(command()),
			).rejects.toThrow("Failed to download attachment");
			expect(sourceDeleted).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("uses the retry attempt identity for attachment replay", async () => {
		let attachmentAttemptId: string | undefined;
		const service = executor({
			[TARGET]: {
				items: { get: async () => targetItem() },
				attachments: { list: async () => ({ data: [] }) },
			},
			[SOURCE]: {
				items: {
					get: async () => ({ data: { version: 1, deletedAt: null } }),
					trash: async () => undefined,
					deletePermanently: async () => undefined,
				},
				attachments: {
					list: async () => ({ data: [{ id: "attachment-1" }] }),
				},
			},
		});
		(
			service as unknown as {
				migrateAttachments(input: {
					attachmentAttemptId: string;
				}): Promise<void>;
			}
		).migrateAttachments = async (input) => {
			attachmentAttemptId = input.attachmentAttemptId;
		};
		await service.executeSemanticItemCommand(
			command({ attemptId: "move-1:attempt:second" }),
		);
		expect(attachmentAttemptId).toBe("move-1:attempt:second");
	});

	test("resumes finalization after trash and a lost permanent-delete response", async () => {
		let state: "trashed" | "missing" = "trashed";
		let attempts = 0;
		const service = executor({
			[TARGET]: { items: { get: async () => targetItem() } },
			[SOURCE]: {
				items: {
					get: async () => {
						if (state === "missing") throw notFound();
						return { data: { version: 2, deletedAt: "now" } };
					},
					deletePermanently: async () => {
						attempts++;
						state = "missing";
						throw new Error("lost delete response");
					},
				},
			},
		});
		await expect(service.executeSemanticItemCommand(command())).rejects.toThrow(
			"lost delete response",
		);
		await expect(
			service.executeSemanticItemCommand(command()),
		).resolves.toEqual({ entityId: "item-source", etag: '"3"', version: 3 });
		expect(attempts).toBe(1);
	});

	test("does not accept a mismatched target after the source is gone", async () => {
		const service = executor({
			[TARGET]: {
				items: { get: async () => targetItem({ encryptedData: "other" }) },
			},
			[SOURCE]: {
				items: {
					get: async () => {
						throw notFound();
					},
				},
			},
		});
		await expect(service.executeSemanticItemCommand(command())).rejects.toThrow(
			"does not match move",
		);
	});
});
