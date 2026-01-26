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

// Core SRP login
export {
	performSRPLogin,
	storeLoginSession,
	type SRPLoginDeps,
} from "./srp-login";

// Core SRP unlock (password unlock with stored secret key)
export {
	performSRPUnlock,
	storeUnlockSession,
	type SRPUnlockDeps,
} from "./srp-unlock";

// Session state utilities
export {
	getSessionState,
	clearSession,
	checkEmailExists,
} from "./session-utils";

// Types
export type {
	SRPLoginInput,
	SRPUnlockInput,
	LoginResult,
	UnlockResult,
	LoginUserData,
	CheckEmailResult,
	SessionState,
	IAuthTRPCClient,
} from "./types";
