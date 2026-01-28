/**
 * Core SRP Unlock Utility
 *
 * Pure function that performs password unlock using stored secret key.
 * Used for quick unlock when user already has a valid session.
 */

import type { IStorageAdapter } from "@bittery/storage";
import type { ICrypto } from "../types";
import type { IAuthTRPCClient, SRPUnlockInput, UnlockResult } from "./types";

/**
 * Dependencies required for SRP unlock
 */
export interface SRPUnlockDeps {
	crypto: ICrypto;
	trpcClient: IAuthTRPCClient;
	storage: IStorageAdapter;
}

/**
 * Performs a password unlock using stored secret key.
 *
 * This function:
 * 1. Retrieves stored secret key
 * 2. Derives auth key and Master Unlock Key from password + stored secret key
 * 3. Performs SRP handshake (same as full login, but uses quickUnlock endpoint)
 * 4. Returns unlock result
 *
 * @param input - Unlock credentials (email, password)
 * @param deps - Platform-specific dependencies (crypto, trpc, storage)
 * @returns Unlock result with token, user data, vault keys, and MUK
 * @throws Error if unlock fails (no stored secret key, invalid password, etc.)
 */
export async function performSRPUnlock(
	input: SRPUnlockInput,
	deps: SRPUnlockDeps,
): Promise<UnlockResult> {
	const { email, password } = input;
	const { crypto, trpcClient, storage } = deps;

	// 1. Get stored secret key
	const storedSecretKey = await storage.getStoredSecretKey(email);
	if (!storedSecretKey) {
		throw new Error(
			"No stored Secret Key found. Please sign in with your full credentials.",
		);
	}

	// 2. Derive keys from password + stored secret key
	const { authKey, masterUnlockKey } = await crypto.deriveKeys(
		password,
		storedSecretKey,
		email,
	);

	// Convert authKey to password string for SRP
	const srpPassword = new TextDecoder().decode(authKey);

	// 3. Generate client ephemeral key pair
	const clientEphemeral = await crypto.generateClientEphemeral();

	// 4. Send client public key to server and get challenge (same as login)
	const startResult = await trpcClient.auth.startLogin.mutate({
		email,
		clientPublicKey: clientEphemeral.publicKey,
	});

	// 5. Derive session and compute proof
	const clientSession = await crypto.deriveClientSession(
		clientEphemeral.secret,
		{
			salt: startResult.salt,
			serverPublicKey: startResult.serverPublicKey,
		},
		srpPassword,
	);

	// 6. Send proof to server using quickUnlock endpoint (includes email for tracking)
	const finishResult = await trpcClient.auth.quickUnlock.mutate({
		email,
		userId: startResult.userId,
		serverSecret: startResult.serverSecret,
		clientPublicKey: clientEphemeral.publicKey,
		clientProof: clientSession.proof,
	});

	// 7. Verify server's proof (completes mutual authentication)
	// serverProof is optional for backwards compatibility with quickUnlock
	if (finishResult.serverProof) {
		await crypto.verifyServerSession(
			clientEphemeral.publicKey,
			clientSession,
			finishResult.serverProof,
		);
	}

	return {
		token: finishResult.token,
		user: finishResult.user,
		vaultKeys: finishResult.vaultKeys,
		masterUnlockKey,
	};
}

/**
 * Store unlock session data after successful unlock.
 *
 * @param result - Unlock result from performSRPUnlock
 * @param storage - Storage adapter
 * @param email - Email for multi-account storage (optional)
 */
export async function storeUnlockSession(
	result: UnlockResult,
	storage: IStorageAdapter,
	email?: string,
): Promise<void> {
	const resolvedEmail = email ?? result.user.email;

	// Store auth token
	await storage.storeAuthToken(result.token, resolvedEmail);

	// Store vault keys
	await storage.storeVaultKeys(result.vaultKeys, resolvedEmail);

	// Store encrypted private key for RSA decryption of shared vault keys
	if (result.user.encryptedPrivateKey) {
		await storage.storeEncryptedPrivateKey(
			result.user.encryptedPrivateKey,
			resolvedEmail,
		);
	}

	// Update session data (refresh expiry)
	await storage.storeSessionData(
		result.masterUnlockKey,
		resolvedEmail,
		result.user.id,
	);

	// Store MUK in memory
	await storage.setMasterUnlockKey(result.masterUnlockKey, resolvedEmail);

	// Ensure active account is set (for multi-account support)
	if (storage.supportsMultiAccount && storage.setActiveAccount) {
		const currentActive = await storage.getActiveAccount();
		// Only set if not already active to avoid unnecessary writes
		if (
			!currentActive ||
			currentActive.type !== "single" ||
			currentActive.email.toLowerCase() !== resolvedEmail.toLowerCase()
		) {
			await storage.setActiveAccount({ type: "single", email: resolvedEmail });
		}
	}

	// Update last master password entry timestamp if the method exists
	if (storage.updateLastMasterPasswordEntry) {
		await storage.updateLastMasterPasswordEntry(resolvedEmail);
	}
}
