import { describe, expect, test } from "bun:test";
import type { DesktopAccountEntry } from "../../src/background/desktop-protocol";
import { desktopAccountToMetadata } from "../../src/background/desktop-sync";

const publishedAccount: DesktopAccountEntry = {
	accountId: "account-1",
	email: "person@example.com",
	userId: "user-1",
	name: "Person",
	secretKeyHint: "AB-CD",
	teamAvatarUrl: null,
	addedAt: 1000,
	lastActiveAt: 2000,
	biometricEnabled: true,
};

describe("desktopAccountToMetadata", () => {
	test("resolves the two fields the desktop never publishes", () => {
		const metadata = desktopAccountToMetadata(
			publishedAccount,
			"https://vault.example.com",
		);

		// The regression: both of these used to be read off the response, where
		// they are declared by nobody and sent by nothing, so every desktop-synced
		// account was stored with an undefined server URL.
		expect(metadata.serverUrl).toBe("https://vault.example.com");
		expect(metadata.insecureTransportConfirmed).toBe(false);
	});

	test("republishes the identity and display fields verbatim", () => {
		const metadata = desktopAccountToMetadata(
			publishedAccount,
			"https://a.test",
		);

		expect(metadata).toEqual({
			accountId: "account-1",
			email: "person@example.com",
			userId: "user-1",
			name: "Person",
			serverUrl: "https://a.test",
			secretKeyHint: "AB-CD",
			teamName: undefined,
			teamAvatarUrl: null,
			addedAt: 1000,
			lastActiveAt: 2000,
			biometricEnabled: true,
			insecureTransportConfirmed: false,
		});
	});

	test("keeps an absent team absent rather than inventing one", () => {
		const metadata = desktopAccountToMetadata(
			{ ...publishedAccount, teamName: "Acme", teamAvatarUrl: null },
			"https://a.test",
		);

		expect(metadata.teamName).toBe("Acme");
		expect(metadata.teamAvatarUrl).toBeNull();
	});
});
