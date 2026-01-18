/**
 * Authentication Handlers
 * Handles LOGIN, QUICK_UNLOCK, CHECK_AUTH, and related authentication messages
 */

import {
	chromeStorage,
	deriveClientSession,
	deriveKeys,
	generateClientEphemeral,
	verifyServerSession,
} from "@bittery/crypto";
import { isUnlocked, lock, setMasterUnlockKey, updateActivity } from "./session-manager";
import { trpcClient } from "./trpc-client";
import type { MessageResponse } from "./types";

/**
 * Handle LOGIN message - Full SRP authentication
 */
export async function handleLogin(payload: {
	email: string;
	password: string;
	secretKey: string;
}): Promise<MessageResponse> {
	const { email, password, secretKey } = payload;

	// 1. Derive keys from password + secret key
	const { authKey, masterUnlockKey: muk } = await deriveKeys(
		password,
		secretKey,
		email,
	);

	// Convert authKey to password string for SRP
	const srpPassword = new TextDecoder().decode(authKey);

	// 2. Generate client ephemeral key pair
	const clientEphemeral = generateClientEphemeral();

	// 3. Send client public key to server and get challenge
	const startResult = await trpcClient.auth.startLogin.mutate({
		email,
		clientPublicKey: clientEphemeral.publicKey,
	});

	// 4. Derive session and compute proof
	const clientSession = await deriveClientSession(
		clientEphemeral.secret,
		{
			salt: startResult.salt,
			serverPublicKey: startResult.serverPublicKey,
		},
		srpPassword,
	);

	// 5. Send proof to server and get session
	const finishResult = await trpcClient.auth.finishLogin.mutate({
		userId: startResult.userId,
		serverSecret: startResult.serverSecret,
		clientPublicKey: clientEphemeral.publicKey,
		clientProof: clientSession.proof,
	});

	// 6. Verify server's proof (completes mutual authentication)
	await verifyServerSession(
		clientEphemeral.publicKey,
		clientSession,
		finishResult.serverProof,
	);

	// Store session data
	await chromeStorage.storeAuthToken(finishResult.token);
	await chromeStorage.storeVaultKeys(finishResult.vaultKeys);
	chromeStorage.storeMasterUnlockKey(muk);
	setMasterUnlockKey(muk);

	// Store secret key and encrypted session for quick unlock
	await chromeStorage.storeSecretKey(secretKey);
	await chromeStorage.storeSessionData(muk, email, finishResult.user.id);

	// Start activity tracking
	updateActivity();

	return { success: true };
}

/**
 * Handle QUICK_UNLOCK message - Fast unlock using stored secret key
 */
export async function handleQuickUnlock(payload: {
	password: string;
}): Promise<MessageResponse> {
	const { password } = payload;

	// Get stored secret key and session data
	const secretKey = await chromeStorage.getStoredSecretKey();
	const sessionData = await chromeStorage.getStoredSessionData();

	if (!secretKey || !sessionData) {
		throw new Error("Quick unlock not available");
	}

	// Derive keys and unlock
	const { authKey, masterUnlockKey: muk } = await deriveKeys(
		password,
		secretKey,
		sessionData.email,
	);

	// Convert authKey to password string for SRP
	const srpPassword = new TextDecoder().decode(authKey);

	// Generate client ephemeral key pair
	const clientEphemeral = generateClientEphemeral();

	// Send client public key to server and get challenge
	const startResult = await trpcClient.auth.startLogin.mutate({
		email: sessionData.email,
		clientPublicKey: clientEphemeral.publicKey,
	});

	// Derive session and compute proof
	const clientSession = await deriveClientSession(
		clientEphemeral.secret,
		{
			salt: startResult.salt,
			serverPublicKey: startResult.serverPublicKey,
		},
		srpPassword,
	);

	// Send proof to server and get vault keys
	const finishResult = await trpcClient.auth.finishLogin.mutate({
		userId: startResult.userId,
		serverSecret: startResult.serverSecret,
		clientPublicKey: clientEphemeral.publicKey,
		clientProof: clientSession.proof,
	});

	// Verify server's proof
	await verifyServerSession(
		clientEphemeral.publicKey,
		clientSession,
		finishResult.serverProof,
	);

	// Store session data and vault keys
	await chromeStorage.storeAuthToken(finishResult.token);
	await chromeStorage.storeVaultKeys(finishResult.vaultKeys);
	chromeStorage.storeMasterUnlockKey(muk);
	setMasterUnlockKey(muk);

	// Start activity tracking
	updateActivity();

	return { success: true };
}

/**
 * Handle CHECK_AUTH message - Check if extension is authenticated and unlocked
 */
export async function handleCheckAuth(): Promise<MessageResponse> {
	// Check if we have a valid session and MUK is still in memory
	const authenticated = await chromeStorage.isAuthenticated();
	const unlocked = isUnlocked();

	if (authenticated) {
		updateActivity();
	}

	return { success: true, authenticated, unlocked };
}

/**
 * Handle CAN_QUICK_UNLOCK message - Check if quick unlock is available
 */
export async function handleCanQuickUnlock(): Promise<MessageResponse> {
	const canQuickUnlock = await chromeStorage.canQuickUnlock();
	return { success: true, canQuickUnlock };
}

/**
 * Handle GET_AUTH_TOKEN message - Get the auth token
 */
export async function handleGetAuthToken(): Promise<MessageResponse> {
	const token = await chromeStorage.getAuthToken();
	return { success: true, token };
}

/**
 * Handle GET_SESSION_DATA message - Get stored session data
 */
export async function handleGetSessionData(): Promise<MessageResponse> {
	const sessionData = await chromeStorage.getStoredSessionData();
	return { success: true, sessionData };
}

/**
 * Handle LOGOUT message - Clear session and lock
 */
export async function handleLogout(): Promise<MessageResponse> {
	await chromeStorage.clearSession();
	lock();
	return { success: true };
}

/**
 * Handle LOCK message - Manual lock (clears MUK but keeps vault keys)
 */
export async function handleLock(): Promise<MessageResponse> {
	lock();
	return { success: true };
}
