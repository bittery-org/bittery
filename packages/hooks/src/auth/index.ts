/**
 * @bittery/hooks/auth
 *
 * Backwards-compatible auth utility exports.
 * The implementation source of truth now lives in @bittery/core.
 */

export {
	type CheckEmailResult,
	checkEmailExists,
	clearSession,
	type FinishLoginResponse,
	getSessionState,
	type IAuthTRPCClient,
	type LoginResult,
	type LoginUserData,
	performSRPLogin,
	performSRPUnlock,
	type SessionState,
	type SRPLoginDeps,
	type SRPLoginInput,
	type SRPUnlockDeps,
	type SRPUnlockInput,
	type StartLoginResponse,
	storeLoginSession,
	storeUnlockSession,
	type UnlockResult,
} from "@bittery/core";
