/**
 * SRP-6a Client Types
 *
 * NOTE: All platforms now use native Rust crypto implementations.
 * This file contains only type definitions for cross-platform compatibility.
 *
 * Platform implementations:
 * - Web: apps/web/src/lib/wasm-crypto.ts
 * - Desktop: apps/desktop/src/lib/tauri-crypto.ts
 * - Mobile: apps/mobile/src/lib/crypto/native-crypto.ts
 * - Extension: apps/extension/src/lib/wasm-crypto.ts
 */

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
