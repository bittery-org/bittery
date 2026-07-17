/**
 * @bittery/core/hooks/auth
 *
 * Auth utility exports for hook consumers.
 */

export {
	type BiometricUnlockAvailability,
	type CheckEmailResult,
	checkEmailExists,
	clearSession,
	deriveSrpLoginProof,
	type FinishLoginResponse,
	getBiometricUnlockAvailability,
	getSessionState,
	type IAuthClient,
	type LoginResult,
	type LoginUserData,
	performSRPLogin,
	performSRPUnlock,
	type SessionState,
	type SRPLoginDeps,
	type SRPLoginInput,
	type SRPUnlockDeps,
	type SRPUnlockInput,
	type SrpLoginProof,
	type StartLoginResponse,
	type StoreAuthSessionOptions,
	storeLoginSession,
	storeUnlockSession,
	type UnlockResult,
} from "../services/auth-service";
