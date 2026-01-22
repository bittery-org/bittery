/**
 * SRP-6a Server Implementation
 * For zero-knowledge authentication - SERVER SIDE ONLY
 */

import { createSRPServer } from "@bittery/srp6a";

// Using SHA-256 and 4096-bit prime group for maximum security
const serverClient = createSRPServer("SHA-256", 4096);

export interface SRPServerEphemeral {
	publicKey: string;
	secret: string;
}

export interface SRPServerSession {
	key: string;
	proof: string;
}

/**
 * Server: Generate challenge (B value) for client
 * Step 2 of login - generates server's ephemeral key pair
 */
export async function generateServerEphemeral(
	verifier: string,
): Promise<SRPServerEphemeral> {
	const ephemeral = await serverClient.generateEphemeral(verifier);

	return {
		publicKey: ephemeral.public,
		secret: ephemeral.secret,
	};
}

/**
 * Server: Derive session and verify client proof
 * Step 4 of login - verifies client's proof and derives session key
 * @throws Error if client proof is invalid
 */
export async function deriveServerSession(
	serverEphemeralSecret: string,
	clientPublicEphemeral: string,
	salt: string,
	verifier: string,
	clientProof: string,
): Promise<SRPServerSession> {
	const session = await serverClient.deriveSession(
		serverEphemeralSecret,
		clientPublicEphemeral,
		salt,
		"", // Empty string when using deriveSafePrivateKey
		verifier,
		clientProof,
	);

	return {
		key: session.key,
		proof: session.proof,
	};
}
