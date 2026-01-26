/**
 * @bittery/hooks/auth
 *
 * Core authentication utilities for SRP login/unlock flows.
 * These are pure functions that can be used in any environment,
 * including extension service workers that can't use React hooks.
 *
 * For React applications, use the hooks in @bittery/hooks instead,
 * which wrap these utilities with React Query for state management.
 */

// Session state utilities
export {
	checkEmailExists,
	clearSession,
	getSessionState,
} from "./session-utils";
// Core SRP login
export {
	performSRPLogin,
	type SRPLoginDeps,
	storeLoginSession,
} from "./srp-login";
// Core SRP unlock (password unlock with stored secret key)
export {
	performSRPUnlock,
	type SRPUnlockDeps,
	storeUnlockSession,
} from "./srp-unlock";

// Types
export type {
	CheckEmailResult,
	IAuthTRPCClient,
	LoginResult,
	LoginUserData,
	SessionState,
	SRPLoginInput,
	SRPUnlockInput,
	UnlockResult,
} from "./types";
