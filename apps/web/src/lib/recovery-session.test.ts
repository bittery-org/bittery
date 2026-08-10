import { afterEach, expect, test } from "bun:test";
import { clearApiClientCache } from "@bittery/shared/api-client-factory";
import { loadRecoveredAccountBootstrap } from "./recovery-session";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	clearApiClientCache();
});

test("recovered account bootstrap uses the newly issued session", async () => {
	// Bun's global fetch carries a `preconnect` method, so a bare function does
	// not satisfy `typeof fetch` — forward the real one alongside the stub.
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request) => {
			const request = new Request(input);
			const authorization = request.headers.get("Authorization");
			if (authorization !== "Bearer recovery-session-token") {
				return new Response(null, { status: 401 });
			}

			const result =
				new URL(request.url).pathname === "/api/v1/users/me"
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

			return Response.json(result);
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
