/**
 * @bittery/core/hooks/auth
 *
 * Auth utility exports for hook consumers.
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
} from "../services/auth-service";
