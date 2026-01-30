/**
 * Auth-specific types for SRP login and unlock flows.
 */

import type { VaultKeyData } from "@bittery/storage";

/**
 * Input for SRP login (full login with password + secret key)
 */
export interface SRPLoginInput {
	email: string;
	password: string;
	secretKey: string;
}

/**
 * Input for SRP unlock (password unlock with stored secret key)
 */
export interface SRPUnlockInput {
	email: string;
	password: string;
}

/**
 * User data returned from login
 */
export interface LoginUserData {
	id: string;
	email: string;
	name?: string;
	teamName?: string;
	teamAvatarUrl?: string | null;
	encryptedPrivateKey?: string;
}

/**
 * Result from successful login
 */
export interface LoginResult {
	token: string;
	user: LoginUserData;
	vaultKeys: VaultKeyData[];
	masterUnlockKey: Uint8Array;
}

/**
 * Result from successful unlock
 */
export interface UnlockResult {
	token: string;
	user: LoginUserData;
	vaultKeys: VaultKeyData[];
	masterUnlockKey: Uint8Array;
}

/**
 * Result from email check
 */
export interface CheckEmailResult {
	exists: boolean;
	secretKeyHint?: string | null;
}

/**
 * Session state information
 */
export interface SessionState {
	/** Whether the session is valid (not expired) */
	isValid: boolean;
	/** Whether quick unlock is available (has stored secret key + valid session) */
	canQuickUnlock: boolean;
	/** Whether biometric unlock is available */
	canBiometricUnlock: boolean;
	/** Whether master password re-entry is required (mobile 30-day policy) */
	requiresPasswordReentry: boolean;
	/** Email of the active account */
	email: string | null;
	/** User ID of the active account */
	userId: string | null;
	/** Session expiry timestamp */
	expiresAt: number | null;
}

/**
 * Start login response (SRP challenge)
 */
export interface StartLoginResponse {
	userId: string;
	salt: string;
	serverPublicKey: string;
	serverSecret: string;
}

/**
 * Finish login response (session data)
 */
export interface FinishLoginResponse {
	token: string;
	serverProof?: string;
	user: LoginUserData;
	vaultKeys: VaultKeyData[];
	sessionId?: string;
}

/**
 * tRPC client interface for auth operations.
 * This is the minimal interface needed by the auth utilities.
 */
export interface IAuthTRPCClient {
	auth: {
		checkEmail: {
			query(input: { email: string }): Promise<CheckEmailResult>;
		};
		startLogin: {
			mutate(input: {
				email: string;
				clientPublicKey: string;
			}): Promise<StartLoginResponse>;
		};
		finishLogin: {
			mutate(input: {
				userId: string;
				serverSecret: string;
				clientPublicKey: string;
				clientProof: string;
			}): Promise<FinishLoginResponse>;
		};
		/**
		 * Quick unlock - same as finishLogin but includes email for tracking.
		 * Used for password-only unlock when secret key is stored locally.
		 */
		quickUnlock: {
			mutate(input: {
				email: string;
				userId: string;
				serverSecret: string;
				clientPublicKey: string;
				clientProof: string;
			}): Promise<FinishLoginResponse>;
		};
		logout: {
			mutate(input: { sessionId: string }): Promise<{ success: boolean }>;
		};
	};
}
