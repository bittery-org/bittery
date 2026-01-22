/**
 * SRP-6a Client Implementation
 * For zero-knowledge authentication - CLIENT SIDE ONLY
 */

import { createSRPClient } from "@bittery/srp6a";

const client = createSRPClient("SHA-256", 4096);

export interface SRPRegistration {
	salt: string;
	verifier: string;
}

export interface SRPClientEphemeral {
	publicKey: string;
	secret: string;
}

export interface SRPServerChallenge {
	salt: string;
	serverPublicKey: string;
}

export interface SRPClientSession {
	key: string;
	proof: string;
}

/**
 * Client: Generate salt and verifier for registration
 * Used during signup to create credentials for the server to store
 */
export async function generateSRPRegistration(
	password: string,
): Promise<SRPRegistration> {
	const salt = client.generateSalt();
	const privateKey = await client.deriveSafePrivateKey(salt, password);
	const verifier = client.deriveVerifier(privateKey);

	return { salt, verifier };
}

/**
 * Client: Start login by generating ephemeral key pair
 * Step 1 of login - generates a random ephemeral key pair
 */
export function generateClientEphemeral(): SRPClientEphemeral {
	const ephemeral = client.generateEphemeral();

	return {
		publicKey: ephemeral.public,
		secret: ephemeral.secret,
	};
}

/**
 * Client: Finish login by computing proof
 * Step 3 of login - derives session key and generates proof for server
 */
export async function deriveClientSession(
	clientEphemeralSecret: string,
	serverChallenge: SRPServerChallenge,
	password: string,
): Promise<SRPClientSession> {
	const privateKey = await client.deriveSafePrivateKey(
		serverChallenge.salt,
		password,
	);

	const session = await client.deriveSession(
		clientEphemeralSecret,
		serverChallenge.serverPublicKey,
		serverChallenge.salt,
		"", // Empty string when using deriveSafePrivateKey
		privateKey,
	);

	return {
		key: session.key,
		proof: session.proof,
	};
}

/**
 * Client: Verify server's proof
 * Step 5 of login - verifies that server has the correct session key
 */
export async function verifyServerSession(
	clientPublicEphemeral: string,
	clientSession: SRPClientSession,
	serverSessionProof: string,
): Promise<void> {
	await client.verifySession(
		clientPublicEphemeral,
		clientSession,
		serverSessionProof,
	);
}
