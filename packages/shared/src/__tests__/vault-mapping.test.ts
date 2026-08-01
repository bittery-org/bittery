import { describe, expect, it } from "bun:test";
import {
	normalizeVaultRole,
	normalizeVaultType,
	type ServerVaultListEntry,
	toCachedVaultFields,
	toVaultKeyEntry,
} from "../vault-mapping";

function serverEntry(
	overrides: Partial<ServerVaultListEntry> = {},
): ServerVaultListEntry {
	return {
		id: "vault_1",
		name: "Team Vault",
		vaultType: "team",
		icon: "lock",
		imageUrl: null,
		encryptedVaultKey: "ZW5jcnlwdGVk",
		role: "owner",
		...overrides,
	};
}

describe("toVaultKeyEntry", () => {
	it("reads the vault type from the wire field the server actually sends", () => {
		expect(toVaultKeyEntry(serverEntry()).vaultType).toBe("team");
	});

	// Regression guard: clients used to read `vault.type`, which does not exist on
	// the camelCased server payload. The resulting `undefined` matched neither
	// "team" nor "personal", so the vault detail page rendered the members dialog
	// with no "add member" button and no personal-vault hint — sharing looked
	// impossible until a cache rebuild happened to restore the field.
	it("never produces a vault key entry without a usable type", () => {
		const payloadWithLegacyKey = {
			...serverEntry(),
			type: "team",
		} as unknown as ServerVaultListEntry;

		for (const entry of [serverEntry(), payloadWithLegacyKey]) {
			const mapped = toVaultKeyEntry(entry);
			expect(
				mapped.vaultType === "team" || mapped.vaultType === "personal",
			).toBe(true);
		}
	});

	it("maps the remaining fields onto the local record", () => {
		expect(toVaultKeyEntry(serverEntry())).toEqual({
			vaultId: "vault_1",
			vaultName: "Team Vault",
			vaultType: "team",
			vaultIcon: "lock",
			vaultImageUrl: null,
			encryptedVaultKey: "ZW5jcnlwdGVk",
			role: "owner",
		});
	});
});

describe("toCachedVaultFields", () => {
	it("renames the wire's vaultType to the cache's type", () => {
		expect(toCachedVaultFields(serverEntry())).toEqual({
			id: "vault_1",
			name: "Team Vault",
			type: "team",
			icon: "lock",
			imageUrl: null,
		});
	});

	it("keeps personal vaults personal", () => {
		expect(
			toCachedVaultFields(serverEntry({ vaultType: "personal" })).type,
		).toBe("personal");
	});
});

describe("normalizeVaultType", () => {
	it("falls back to personal for unknown or missing values", () => {
		expect(normalizeVaultType(undefined)).toBe("personal");
		expect(normalizeVaultType(null)).toBe("personal");
		expect(normalizeVaultType("nonsense")).toBe("personal");
	});
});

describe("normalizeVaultRole", () => {
	it("passes through known roles", () => {
		expect(normalizeVaultRole("owner")).toBe("owner");
		expect(normalizeVaultRole("admin")).toBe("admin");
		expect(normalizeVaultRole("read-only")).toBe("read-only");
	});

	it("falls back to the least privileged writable role", () => {
		expect(normalizeVaultRole(undefined)).toBe("member");
		expect(normalizeVaultRole("superuser")).toBe("member");
	});
});
