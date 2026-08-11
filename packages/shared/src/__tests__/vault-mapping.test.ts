import { describe, expect, it } from "bun:test";
import {
	decodeVaultRole,
	decodeVaultType,
	type ServerAuthVaultKeyEntry,
	type ServerVaultListEntry,
	toAuthVaultKeyEntry,
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

function authVaultKey(
	overrides: Partial<ServerAuthVaultKeyEntry> = {},
): ServerAuthVaultKeyEntry {
	return {
		vaultId: "vault_1",
		vaultName: "Team Vault",
		vaultType: "team",
		vaultIcon: "lock",
		vaultImageUrl: null,
		encryptedVaultKey: "ZW5jcnlwdGVk",
		role: "owner",
		...overrides,
	};
}

describe("toVaultKeyEntry", () => {
	it("reads the vault type from the wire field the server actually sends", () => {
		expect(toVaultKeyEntry(serverEntry()).vaultType).toBe("team");
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

describe("toAuthVaultKeyEntry", () => {
	it("decodes auth wire fields into the canonical key shape", () => {
		expect(toAuthVaultKeyEntry(authVaultKey())).toEqual({
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
		const decoded = toCachedVaultFields(serverEntry());

		expect(decoded).toEqual({
			id: "vault_1",
			name: "Team Vault",
			type: "team",
			icon: "lock",
			imageUrl: null,
		});
		expect(decoded).not.toHaveProperty("vaultType");
	});

	it("keeps personal vaults personal", () => {
		expect(
			toCachedVaultFields(serverEntry({ vaultType: "personal" })).type,
		).toBe("personal");
	});
});

describe("decodeVaultType", () => {
	it("falls back to personal for unknown or missing values", () => {
		expect(decodeVaultType(undefined)).toBe("personal");
		expect(decodeVaultType(null)).toBe("personal");
		expect(decodeVaultType("nonsense")).toBe("personal");
	});
});

describe("decodeVaultRole", () => {
	it("passes through known roles", () => {
		expect(decodeVaultRole("owner")).toBe("owner");
		expect(decodeVaultRole("admin")).toBe("admin");
		expect(decodeVaultRole("read-only")).toBe("read-only");
	});

	it("falls back to the least privileged writable role", () => {
		expect(decodeVaultRole(undefined)).toBe("member");
		expect(decodeVaultRole("superuser")).toBe("member");
	});
});
