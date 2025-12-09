/**
 * SRP-6a (Secure Remote Password) Implementation
 * For zero-knowledge authentication
 */

import { sha256 } from "@noble/hashes/sha2";
import {
	createVerifierAndSalt,
	SRPClientSessionStep1,
	SRPParameters,
	SRPRoutines,
	SRPServerSessionStep1,
	SRPClientSession as TSRPClientSession,
	SRPServerSession as TSRPServerSession,
} from "tssrp6a";

// SHA-256 hash function adapter for tssrp6a
const hashFunction = async (data: ArrayBuffer): Promise<ArrayBuffer> => {
	const hash = sha256(new Uint8Array(data));
	return new Uint8Array(hash).buffer;
};

const srpParams = new SRPParameters(
	SRPParameters.PrimeGroup[4096],
	hashFunction,
);
const srpRoutines = new SRPRoutines(srpParams);

export interface SRPRegistration {
	salt: string;
	verifier: string;
}

export interface SRPClientSessionData {
	clientPublicKey: string;
	clientSecret: string;
}

export interface SRPServerChallenge {
	salt: string;
	serverPublicKey: string;
}

/**
 * Client: Generate salt and verifier for registration
 */
export async function generateSRPRegistration(
	email: string,
	authKey: Uint8Array,
): Promise<SRPRegistration> {
	const identifier = email.toLowerCase();
	const password = new TextDecoder().decode(authKey);

	const { s, v } = await createVerifierAndSalt(
		srpRoutines,
		identifier,
		password,
	);

	const saltHex = s.toString(16);
	const verifierHex = v.toString(16);

	return { salt: saltHex, verifier: verifierHex };
}

/**
 * Client: Start login by generating ephemeral key pair
 */
export async function startSRPLogin(
	email: string,
	authKey: Uint8Array,
): Promise<SRPClientSessionData> {
	const identifier = email.toLowerCase();
	const password = new TextDecoder().decode(authKey);

	const clientSession = new TSRPClientSession(srpRoutines);
	const step1 = await clientSession.step1(identifier, password);

	const clientSessionState = step1.toJSON();

	return {
		clientPublicKey: "", // Will be computed and returned from finishSRPLogin
		clientSecret: JSON.stringify({
			email,
			clientSessionState,
		}),
	};
}

/**
 * Client: Finish login by computing proof M1
 */
export async function finishSRPLogin(
	clientSecret: string,
	serverChallenge: SRPServerChallenge,
): Promise<{ proof: string; sessionKey: string; clientPublicKey: string }> {
	const { clientSessionState } = JSON.parse(clientSecret);
	const salt = BigInt(`0x${serverChallenge.salt}`);
	const serverPublicKey = BigInt(`0x${serverChallenge.serverPublicKey}`);

	const step1 = SRPClientSessionStep1.fromState(
		srpRoutines,
		clientSessionState,
	);
	const step2 = await step1.step2(salt, serverPublicKey);

	const clientPublicKey = step2.A.toString(16);
	const proof = step2.M1.toString(16);
	const sessionKey = step2.S.toString(16);

	return { proof, sessionKey, clientPublicKey };
}

/**
 * Server: Generate challenge (B value) for client
 */
export async function generateSRPChallenge(
	verifier: string,
	salt: string,
	identifier: string,
): Promise<{ serverPublicKey: string; serverSecret: string }> {
	const verifierBigInt = BigInt(`0x${verifier}`);
	const saltBigInt = BigInt(`0x${salt}`);

	const serverSession = new TSRPServerSession(srpRoutines);
	const step1 = await serverSession.step1(
		identifier,
		saltBigInt,
		verifierBigInt,
	);

	const serverPublicKey = step1.B.toString(16);
	const serverSessionState = step1.toJSON();

	return {
		serverPublicKey,
		serverSecret: JSON.stringify({
			verifier,
			salt,
			identifier,
			serverSessionState,
		}),
	};
}

/**
 * Server: Verify client proof M1
 */
export async function verifySRPProof(
	serverSecret: string,
	clientPublicKey: string,
	clientProof: string,
): Promise<{ valid: boolean; sessionKey: string | null }> {
	const { serverSessionState } = JSON.parse(serverSecret);
	const clientPublicKeyBigInt = BigInt(`0x${clientPublicKey}`);
	const clientProofBigInt = BigInt(`0x${clientProof}`);

	try {
		const step1 = SRPServerSessionStep1.fromState(
			srpRoutines,
			serverSessionState,
		);

		await step1.step2(clientPublicKeyBigInt, clientProofBigInt);
		const sessionKey = await step1.sessionKey(clientPublicKeyBigInt);

		return { valid: true, sessionKey: sessionKey.toString(16) };
	} catch {
		return { valid: false, sessionKey: null };
	}
}
