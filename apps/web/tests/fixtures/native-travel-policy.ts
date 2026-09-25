import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Page } from "@playwright/test";
import type { TestUser } from "./auth";

/** A separately authenticated fixture Device changes Server policy; native Core owns its reaction. */
export async function nativeTravelPolicy(
	page: Page,
	directory: string,
	user: TestUser,
) {
	if (!user.secretKey)
		throw new Error("Policy fixture requires the provisioned Secret Key");
	const request = join(directory, "native-travel-policy-request");
	const acknowledgement = join(
		directory,
		"native-travel-policy-acknowledgement",
	);
	await writeFile(request, "", { mode: 0o600 });
	await writeFile(acknowledgement, "", { mode: 0o600 });
	const repository = resolve(import.meta.dirname, "../../../..");
	// A browser handle owns these closures. Neither its Session nor keys are published to the
	// live Web Runtime, a browser global, localStorage, the Node runner, or native Core.
	const device = await page.evaluateHandle(
		async ({ user, repository }) => {
			let phase = "imports";
			let clear: (() => Promise<void>) | undefined;
			let remoteCreated = false;
			let retired = false;
			const failure = (error: unknown) => ({
				ok: false,
				phase,
				status:
					typeof error === "object" &&
					error !== null &&
					"status" in error &&
					typeof error.status === "number"
						? error.status
						: null,
			});
			try {
				const cryptoPath = "/src/lib/crypto.ts";
				const serverPath = "/src/lib/auth-server.ts";
				const storagePath = `/@fs${repository}/packages/storage/src/index.ts`;
				const memoryPath = `/@fs${repository}/packages/storage/src/testing/in-memory-port.ts`;
				const authPath = `/@fs${repository}/packages/core/src/services/auth-service.ts`;
				const apiPath = `/@fs${repository}/packages/shared/src/api-client-factory.ts`;
				const { crypto } = (await import(
					cryptoPath
				)) as typeof import("../../src/lib/crypto");
				const { getServerUrl } = (await import(
					serverPath
				)) as typeof import("../../src/lib/auth-server");
				const { createAccountStore, createItemCache } = (await import(
					storagePath
				)) as typeof import("@bittery/storage");
				const { createInMemoryPlatformPort, createInMemoryRecordPort } =
					(await import(
						memoryPath
					)) as typeof import("@bittery/storage/testing");
				const { performSRPLogin, storeLoginSessionOwned, deriveSrpLoginProof } =
					(await import(
						authPath
					)) as typeof import("@bittery/core/services/auth-service");
				const { createApiClientForServer, createAccountApiClient } =
					(await import(
						apiPath
					)) as typeof import("@bittery/shared/api-client-factory");
				const storage = createAccountStore({
					port: createInMemoryPlatformPort(),
					crypto,
				});
				const itemCache = createItemCache({ port: createInMemoryRecordPort() });
				let accountId: string | undefined;
				clear = async () => {
					if (accountId) await itemCache.clearItemCache(accountId);
					await storage.clearAllStoredData(accountId);
				};
				await storage.initialize();
				await itemCache.initialize();
				const serverUrl = getServerUrl();
				const clientId = globalThis.crypto.randomUUID();
				const metadata = {
					clientPlatform: "web",
					clientVersion: "native-policy-fixture",
					insecureTransportConfirmed: true,
				};
				phase = "fixture-srp-login";
				const login = await performSRPLogin(
					{
						email: user.email,
						password: user.password,
						secretKey: user.secretKey,
						serverUrl,
						insecureTransportConfirmed: true,
					},
					{
						crypto,
						storage,
						apiClient: createApiClientForServer(serverUrl, clientId, metadata),
					},
				);
				remoteCreated = true;
				// This token is the result of this fixture's own SRP ceremony, never a Core Session read.
				const apiClient = createAccountApiClient(
					login.token,
					serverUrl,
					clientId,
					undefined,
					metadata,
				);
				phase = "fixture-session-store";
				accountId = await storeLoginSessionOwned(
					login,
					user.secretKey,
					storage,
					itemCache,
					crypto,
					user.email,
					{ serverUrl, insecureTransportConfirmed: true },
				);
				const close = async (userDeletionProven: boolean) => {
					let error: ReturnType<typeof failure> | undefined;
					if (!retired) {
						phase = "fixture-user-deletion-proof";
						if (userDeletionProven) retired = true;
						else error = failure(undefined);
					}
					phase = "fixture-storage-cleanup";
					try {
						await clear?.();
					} catch (cause) {
						error ??= failure(cause);
					}
					return error ?? { ok: true, phase: "fixture-closed", status: null };
				};
				return {
					async apply(input: { action: string; vaultId: string }) {
						try {
							phase =
								input.action === "enable" ? "enable-http" : "disable-proof";
							const { data: config } =
								input.action === "enable"
									? await apiClient.travelMode.enable({
											hiddenVaultIds: [input.vaultId],
										})
									: await (async () => {
											const proof = await deriveSrpLoginProof(
												{
													accountId: accountId as string,
													password: user.password,
												},
												{ storage, crypto, apiClient },
											);
											phase = "disable-http";
											return apiClient.travelMode.disable(proof);
										})();
							phase = "response-validation";
							if (
								config.enabled !== (input.action === "enable") ||
								!config.hiddenVaultIds.includes(input.vaultId)
							)
								throw new Error(
									"Actual policy response differs from the selected Vault",
								);
							if (input.action === "disable") {
								// The Server rejects self-revocation. Drop this fixture's local
								// credentials now; the existing mandatory public User deletion
								// proves retirement of its remote Session during final cleanup.
								phase = "fixture-storage-cleanup";
								await clear?.();
							}
							return { ok: true, phase, status: null };
						} catch (error) {
							return failure(error);
						}
					},
					close,
				};
			} catch (error) {
				const original = failure(error);
				const cleanup = await Promise.allSettled([clear?.()]);
				const cleanupFailed =
					(remoteCreated && !retired) ||
					cleanup.some((result) => result.status === "rejected");
				throw new Error(
					`Native policy fixture setup failed at ${original.phase}; HTTP status=${original.status ?? "unavailable"}; cleanup=${cleanupFailed ? "failed" : "completed"}`,
				);
			}
		},
		{ user, repository },
	);
	let stopped = false;
	let previous = "";
	const actions: string[] = [];
	const task = (async () => {
		while (!stopped) {
			const raw = await readFile(request, "utf8");
			if (raw && raw !== previous) {
				const input = JSON.parse(raw) as {
					action: string;
					vaultId: string;
					operationId: string;
				};
				if (
					!["enable", "disable"].includes(input.action) ||
					![input.vaultId, input.operationId].every((id) =>
						/^[0-9a-f-]{36}$/.test(id),
					)
				)
					throw new Error("Invalid native policy fixture request");
				previous = raw;
				try {
					const result = await device.evaluate(
						(owner, input) => owner.apply(input),
						input,
					);
					if (!result.ok) {
						console.error(
							`Native policy fixture failed at ${result.phase}; HTTP status=${result.status ?? "unavailable"}`,
						);
						throw new Error("Actual second-device policy phase failed");
					}
					console.info(
						"Native policy fixture completed:",
						input.action,
						Date.now(),
					);
					actions.push(input.action);
					await writeFile(
						acknowledgement,
						JSON.stringify({ ...input, ok: true }),
					);
				} catch {
					await writeFile(
						acknowledgement,
						JSON.stringify({ ...input, ok: false }),
					);
					throw new Error(
						`Actual second-device Server policy ${input.action} failed`,
					);
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	})();
	void task.catch(() => undefined);
	return {
		request,
		acknowledgement,
		actions,
		async close(userDeletionProven: boolean) {
			stopped = true;
			const settled = await Promise.allSettled([task]);
			try {
				const result = await device.evaluate(
					(owner, proven) => owner.close(proven),
					userDeletionProven,
				);
				if (!result.ok)
					throw new Error(
						`Native fixture cleanup failed at ${result.phase}; HTTP status=${result.status ?? "unavailable"}`,
					);
				if (settled[0]?.status === "rejected") throw settled[0].reason;
			} finally {
				await device.dispose();
			}
		},
	};
}
