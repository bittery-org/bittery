// Browser-only fixture Devices. Their own SRP Sessions live only in isolated memory stores.
import {
	performSRPLogin,
	storeLoginSessionOwned,
} from "@bittery/core/services/auth-service";
import { createVaultCrypto } from "@bittery/core/services/vault-crypto";
import {
	createAccountApiClient,
	createApiClientForServer,
} from "@bittery/shared/api-client-factory";
import { createAccountStore, createItemCache } from "@bittery/storage";
import {
	createInMemoryPlatformPort,
	createInMemoryRecordPort,
} from "@bittery/storage/testing";
import { getServerUrl } from "../../src/lib/auth-server";
import { crypto, runtimeClient } from "../../src/lib/crypto";
import type { TestUser } from "./auth";

interface FixtureDevice {
	api: ReturnType<typeof createAccountApiClient>;
	accountId: string;
	userId: string;
	vaultCrypto: ReturnType<typeof createVaultCrypto>;
}

export interface RecipientIdentity {
	userId: string;
	email: string;
	fingerprint: string;
}

async function withFixtureDevice<T>(
	user: TestUser,
	action: (device: FixtureDevice) => Promise<T>,
): Promise<T> {
	const storage = createAccountStore({
		port: createInMemoryPlatformPort(),
		crypto,
	});
	const itemCache = createItemCache({ port: createInMemoryRecordPort() });
	try {
		await storage.initialize();
		await itemCache.initialize();
		const serverUrl = getServerUrl();
		const clientId = globalThis.crypto.randomUUID();
		const metadata = {
			clientPlatform: "web" as const,
			clientVersion: "native-membership-fixture",
			insecureTransportConfirmed: true,
		};
		const login = await performSRPLogin(
			{ ...user, serverUrl, insecureTransportConfirmed: true },
			{
				crypto,
				storage,
				apiClient: createApiClientForServer(serverUrl, clientId, metadata),
			},
		);
		const accountId = await storeLoginSessionOwned(
			login,
			user.secretKey,
			storage,
			itemCache,
			crypto,
			user.email,
			{ serverUrl, insecureTransportConfirmed: true },
		);
		return await action({
			api: createAccountApiClient(
				login.token,
				serverUrl,
				clientId,
				undefined,
				metadata,
			),
			accountId,
			userId: login.user.id,
			vaultCrypto: createVaultCrypto({ crypto, storage }),
		});
	} finally {
		// This fixture never mirrors a Core Session. Public User deletion in the outer
		// fixture retires its remote Session; every local key/store is cleared immediately.
		for (const account of await storage.getAccountsList()) {
			try {
				await itemCache.clearItemCache(account.accountId);
			} finally {
				await storage.clearAllStoredData(account.accountId);
			}
		}
		await storage.clearAllStoredData();
	}
}

function failure(phase: string, error: unknown) {
	return {
		ok: false as const,
		phase,
		status:
			typeof error === "object" &&
			error !== null &&
			"status" in error &&
			typeof error.status === "number"
				? error.status
				: null,
	};
}

export async function inviteTeamMember(
	user: TestUser,
	email: string,
	role: "member" | "admin" = "member",
) {
	let phase = "inviter-srp";
	try {
		return await withFixtureDevice(user, async ({ api }) => {
			phase = "team-invitation";
			const { data: team } = await api.teams.current();
			const { data: invitation } = await api.teams.invitations.send(team.id, {
				email,
				role,
				pendingVaultKeys: null,
			});
			if (invitation.existingUserId || invitation.existingUserPublicKey)
				throw new Error("Read-only fixture requires a new invited User");
			return { ok: true as const, token: invitation.token };
		});
	} catch (error) {
		return failure(phase, error);
	}
}

export async function inviteVaultOwner(user: TestUser, email: string) {
	return inviteTeamMember(user, email, "admin");
}

export async function grantReadOnlyVault(
	user: TestUser,
	ownerAccountId: string,
	vaultId: string,
	recipient: RecipientIdentity,
) {
	let phase = "vault-owner-srp";
	try {
		return await withFixtureDevice(user, async (device) => {
			phase = "recipient-fingerprint-proof";
			const { data: available } =
				await device.api.teams.availableMembersForVault(vaultId);
			const members = available.filter(
				(member) =>
					member.userId === recipient.userId &&
					member.email === recipient.email,
			);
			const member = members.length === 1 ? members[0] : undefined;
			if (!member) throw new Error("Exact fixture recipient is unavailable");
			const { scope } = await runtimeClient.recipientKeyScope({
				accountId: ownerAccountId,
			});
			const keyRequest = {
				accountId: ownerAccountId,
				scope,
				recipientUserId: member.userId,
				publicKey: member.publicKey,
			};
			await runtimeClient.verifyRecipientKey({
				...keyRequest,
				expectedFingerprint: recipient.fingerprint,
			});
			const verified = await runtimeClient.verifiedRecipientKey(keyRequest);
			phase = "member-key-envelope";
			const vaultKey = await device.vaultCrypto.getVaultKey({
				vaultId,
				accountId: device.accountId,
				userId: device.userId,
			});
			if (!vaultKey) throw new Error("Fixture owner has no shared Vault key");
			let encryptedVaultKey: string;
			try {
				encryptedVaultKey = await crypto.encryptVaultKeyForMember(
					vaultKey,
					verified.publicKey,
				);
			} finally {
				await crypto.destroyKey(vaultKey);
			}
			await runtimeClient.verifiedRecipientKey(keyRequest);
			phase = "read-only-membership";
			await device.api.vaults.members.add(vaultId, member.userId, {
				encryptedVaultKey,
				role: "read-only",
			});
			const { data: granted } = await device.api.vaults.members.list(vaultId);
			if (
				!granted.some(
					(entry) =>
						entry.userId === member.userId && entry.role === "read-only",
				)
			)
				throw new Error("Server did not retain exact read-only membership");
			return { ok: true as const };
		});
	} catch (error) {
		return failure(phase, error);
	}
}
