import { expect, test } from "bun:test";
import type { DecryptedItemWithContext } from "@bittery/shared/types";
import { privateMoveData } from "./legacy-item-move";

test("legacy Desktop Move carries the private credential and omits Item metadata", () => {
	const item: DecryptedItemWithContext = {
		id: "item-1",
		vaultId: "vault-1",
		category: "login",
		favorite: true,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-09-23T00:00:00Z",
		accountId: "account-1",
		account: { accountId: "account-1", email: "alice@bank.test" },
		title: "Bank",
		username: "alice",
		password: "password",
		passwordHistory: [{ password: "earlier", changedAt: "2026-01-01" }],
		passkeys: [
			{
				credentialId: "credential-1",
				rpId: "bank.test",
				rpName: "Bank",
				userHandle: "dXNlcg",
				userName: "alice",
				userDisplayName: "Alice",
				privateKey: "EXACT_PRIVATE_ES256_SCALAR",
				publicKey: "EXACT_PUBLIC_ES256_POINT",
				algorithm: -7,
				signCount: 3,
				transports: ["internal"],
				createdAt: "2026-01-01T00:00:00Z",
			},
		],
	};

	const data = privateMoveData(item);
	expect(data.passkeys?.[0]?.privateKey).toBe("EXACT_PRIVATE_ES256_SCALAR");
	expect(data.passwordHistory).toEqual(item.passwordHistory);
	expect(data).not.toHaveProperty("id");
	expect(data).not.toHaveProperty("vaultId");
	expect(data).not.toHaveProperty("category");
	expect(data).not.toHaveProperty("favorite");
	expect(data).not.toHaveProperty("accountId");
	expect(data).not.toHaveProperty("account");
});
