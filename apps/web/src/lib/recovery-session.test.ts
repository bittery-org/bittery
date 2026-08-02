import { afterEach, expect, test } from "bun:test";
import { clearRpcClientCache } from "@bittery/shared/rpc-client-factory";
import { loadRecoveredAccountBootstrap } from "./recovery-session";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	clearRpcClientCache();
});

test("recovered account bootstrap uses the newly issued session", async () => {
	// Bun's global fetch carries a `preconnect` method, so a bare function does
	// not satisfy `typeof fetch` — forward the real one alongside the stub.
	globalThis.fetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit) => {
			const request = JSON.parse(String(init?.body));
			const authorization = new Headers(init?.headers).get("Authorization");
			if (authorization !== "Bearer recovery-session-token") {
				return Response.json({
					jsonrpc: "2.0",
					id: request.id,
					error: { code: 401, message: "Authentication required" },
				});
			}

			const result =
				request.method === "auth.me"
					? {
							id: "user-1",
							email: "recovered@example.com",
							name: "Recovered User",
							teamId: null,
							teamName: null,
							teamType: null,
							teamAvatarUrl: null,
							role: "owner",
							secretKeyHint: "A3-TEST",
							publicKey: "public-key",
							encryptedPrivateKey: "encrypted-private-key",
							hasRecoveryKey: true,
							createdAt: "2026-08-02T00:00:00Z",
						}
					: [
							{
								id: "vault-1",
								name: "Personal",
								vaultType: "personal",
								icon: null,
								imageUrl: null,
								encryptedVaultKey: "encrypted-vault-key",
								role: "owner",
								createdById: "user-1",
							},
						];

			return Response.json({
				jsonrpc: "2.0",
				id: request.id,
				result: { Ok: result },
			});
		},
		{ preconnect: originalFetch.preconnect },
	);

	const bootstrap = await loadRecoveredAccountBootstrap({
		token: "recovery-session-token",
		serverUrl: "https://api.example.com",
	});

	expect({
		userId: bootstrap.user.id,
		vaultIds: bootstrap.vaults.map((vault) => vault.id),
	}).toEqual({ userId: "user-1", vaultIds: ["vault-1"] });
});
