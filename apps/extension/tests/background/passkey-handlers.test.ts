import { describe, expect, test } from "bun:test";
import type { Passkey } from "@bittery/shared/types";
import {
	findMatchingPasskeysForItems,
	resolveCreateDecision,
	resolveGetSelection,
	resolveUnknownCredentialSuspectMatch,
} from "../../src/background/passkey-handlers";
import type { PasskeyWritableVaultOption } from "../../src/passkey/types";

function createPasskey(input: {
	credentialId: string;
	rpId: string;
	userName: string;
	lastUsedAt?: string;
}): Passkey {
	return {
		credentialId: input.credentialId,
		rpId: input.rpId,
		rpName: "Example",
		userHandle: "dXNlcg",
		userName: input.userName,
		userDisplayName: input.userName,
		privateKey: "private",
		publicKey: "public",
		algorithm: -7,
		signCount: 1,
		transports: ["internal"],
		createdAt: "2026-01-01T00:00:00.000Z",
		lastUsedAt: input.lastUsedAt,
	};
}

function createLoginItem(input: {
	id: string;
	username: string;
	url: string;
	passkeys: Passkey[];
}): Record<string, unknown> {
	return {
		id: input.id,
		vaultId: "vault_1",
		category: "login",
		favorite: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		title: `Title ${input.id}`,
		username: input.username,
		url: input.url,
		passkeys: input.passkeys,
		vault: { name: "Personal" },
		account: { email: "alice@example.com" },
	};
}

describe("passkey handler helpers", () => {
	test("filters and ranks passkey matches using allowCredentials", () => {
		const items = [
			createLoginItem({
				id: "item_1",
				username: "alice",
				url: "https://example.com",
				passkeys: [
					createPasskey({
						credentialId: "cred_old",
						rpId: "example.com",
						userName: "alice",
						lastUsedAt: "2026-01-10T00:00:00.000Z",
					}),
				],
			}),
			createLoginItem({
				id: "item_2",
				username: "bob",
				url: "https://example.com",
				passkeys: [
					createPasskey({
						credentialId: "cred_new",
						rpId: "example.com",
						userName: "bob",
						lastUsedAt: "2026-02-10T00:00:00.000Z",
					}),
					createPasskey({
						credentialId: "other_rp",
						rpId: "other.com",
						userName: "bob",
					}),
				],
			}),
		] as never[];

		const allMatches = findMatchingPasskeysForItems({
			items,
			rpId: "example.com",
		});
		expect(allMatches.map((entry) => entry.passkey.credentialId)).toEqual([
			"cred_new",
			"cred_old",
		]);

		const filteredMatches = findMatchingPasskeysForItems({
			items,
			rpId: "example.com",
			allowCredentials: [{ type: "public-key", id: "cred_old" }],
		});
		expect(filteredMatches.map((entry) => entry.passkey.credentialId)).toEqual([
			"cred_old",
		]);
	});

	test("requires explicit picker selection for multi-match get", () => {
		const items = [
			createLoginItem({
				id: "item_1",
				username: "alice",
				url: "https://example.com",
				passkeys: [
					createPasskey({
						credentialId: "cred_a",
						rpId: "example.com",
						userName: "alice",
					}),
				],
			}),
			createLoginItem({
				id: "item_2",
				username: "bob",
				url: "https://example.com",
				passkeys: [
					createPasskey({
						credentialId: "cred_b",
						rpId: "example.com",
						userName: "bob",
					}),
				],
			}),
		] as never[];
		const matches = findMatchingPasskeysForItems({
			items,
			rpId: "example.com",
		});

		const promptResolution = resolveGetSelection({
			matches,
		});
		expect(promptResolution.kind).toBe("prompt");
		if (promptResolution.kind !== "prompt") {
			throw new Error("Expected prompt resolution");
		}
		expect(promptResolution.options).toHaveLength(2);

		const selectedResolution = resolveGetSelection({
			matches,
			selectedCredentialId: "cred_b",
		});
		expect(selectedResolution.kind).toBe("selected");
		if (selectedResolution.kind !== "selected") {
			throw new Error("Expected selected resolution");
		}
		expect(selectedResolution.match.passkey.credentialId).toBe("cred_b");
	});

	test("requires explicit picker selection for single-match get", () => {
		const items = [
			createLoginItem({
				id: "item_1",
				username: "alice",
				url: "https://example.com",
				passkeys: [
					createPasskey({
						credentialId: "cred_only",
						rpId: "example.com",
						userName: "alice",
					}),
				],
			}),
		] as never[];
		const matches = findMatchingPasskeysForItems({
			items,
			rpId: "example.com",
		});

		const promptResolution = resolveGetSelection({
			matches,
		});
		expect(promptResolution.kind).toBe("prompt");
		if (promptResolution.kind !== "prompt") {
			throw new Error("Expected prompt resolution");
		}
		expect(promptResolution.options).toHaveLength(1);
		expect(promptResolution.options[0]?.credentialId).toBe("cred_only");
	});

	test("returns no-match fallback decision for get", () => {
		const resolution = resolveGetSelection({
			matches: [],
		});
		expect(resolution).toEqual({
			kind: "fallback",
			reason: "no_match",
		});
	});

	test("resolves unknown-credential suspect for single stored passkey when allowCredentials mismatch", () => {
		const items = [
			createLoginItem({
				id: "item_1",
				username: "alice",
				url: "https://example.com",
				passkeys: [
					createPasskey({
						credentialId: "cred_only",
						rpId: "example.com",
						userName: "alice",
					}),
				],
			}),
		] as never[];

		const rpMatches = findMatchingPasskeysForItems({
			items,
			rpId: "example.com",
		});
		const suspect = resolveUnknownCredentialSuspectMatch({
			rpMatches,
			allowCredentials: [{ type: "public-key", id: "server_cred_1" }],
		});

		expect(suspect?.passkey.credentialId).toBe("cred_only");
	});

	test("does not auto-mark unknown-credential when multiple stored passkeys are ambiguous", () => {
		const items = [
			createLoginItem({
				id: "item_1",
				username: "alice",
				url: "https://example.com",
				passkeys: [
					createPasskey({
						credentialId: "cred_a",
						rpId: "example.com",
						userName: "alice",
					}),
				],
			}),
			createLoginItem({
				id: "item_2",
				username: "bob",
				url: "https://example.com",
				passkeys: [
					createPasskey({
						credentialId: "cred_b",
						rpId: "example.com",
						userName: "bob",
					}),
				],
			}),
		] as never[];

		const rpMatches = findMatchingPasskeysForItems({
			items,
			rpId: "example.com",
		});
		const suspect = resolveUnknownCredentialSuspectMatch({
			rpMatches,
			allowCredentials: [{ type: "public-key", id: "server_cred_1" }],
		});

		expect(suspect).toBeNull();
	});

	test("marks explicit selection as unknown-credential suspect even in ambiguous set", () => {
		const items = [
			createLoginItem({
				id: "item_1",
				username: "alice",
				url: "https://example.com",
				passkeys: [
					createPasskey({
						credentialId: "cred_a",
						rpId: "example.com",
						userName: "alice",
					}),
				],
			}),
			createLoginItem({
				id: "item_2",
				username: "bob",
				url: "https://example.com",
				passkeys: [
					createPasskey({
						credentialId: "cred_b",
						rpId: "example.com",
						userName: "bob",
					}),
				],
			}),
		] as never[];

		const rpMatches = findMatchingPasskeysForItems({
			items,
			rpId: "example.com",
		});
		const suspect = resolveUnknownCredentialSuspectMatch({
			rpMatches,
			allowCredentials: [{ type: "public-key", id: "server_cred_1" }],
			selectedCredentialId: "cred_b",
		});

		expect(suspect?.passkey.credentialId).toBe("cred_b");
	});

	test("requires explicit save-target decision for ambiguous create", () => {
		const candidateItems = [
			createLoginItem({
				id: "item_1",
				username: "alice-1",
				url: "https://example.com",
				passkeys: [
					createPasskey({
						credentialId: "cred_a",
						rpId: "example.com",
						userName: "alice-1",
					}),
				],
			}),
			createLoginItem({
				id: "item_2",
				username: "alice-2",
				url: "https://example.com",
				passkeys: [
					createPasskey({
						credentialId: "cred_b",
						rpId: "example.com",
						userName: "alice-2",
					}),
				],
			}),
		] as never[];
		const writableVaults: PasskeyWritableVaultOption[] = [
			{
				id: "vault_1",
				name: "Personal",
				type: "personal",
				role: "owner",
			},
		];

		const promptResolution = resolveCreateDecision({
			candidateItems,
			userName: "alice",
			writableVaults,
		});
		expect(promptResolution).toEqual({
			kind: "prompt",
		});

		const attachResolution = resolveCreateDecision({
			candidateItems,
			userName: "alice",
			writableVaults,
			createDecision: {
				action: "attach-existing",
				itemId: "item_2",
			},
		});
		expect(attachResolution.kind).toBe("attach-existing");
		if (attachResolution.kind !== "attach-existing") {
			throw new Error("Expected attach-existing resolution");
		}
		expect(attachResolution.item.id).toBe("item_2");

		const createNewResolution = resolveCreateDecision({
			candidateItems,
			userName: "alice",
			writableVaults,
			createDecision: {
				action: "create-new",
				vaultId: "vault_1",
			},
		});
		expect(createNewResolution).toEqual({
			kind: "create-new",
			vault: writableVaults[0],
		});
	});
});
