/**
 * Auth Hooks
 *
 * React hooks for authentication operations.
 * These hooks wrap the core auth utilities with React Query
 * for state management and caching.
 */

// Biometric unlock hook (Touch ID / Face ID)
export {
	type BiometricUnlockError,
	type BiometricUnlockInput,
	type BiometricUnlockResult,
	type UseBiometricUnlockOptions,
	useBiometricUnlock,
} from "./use-biometric-unlock";
// Check email hook
export {
	type UseCheckEmailOptions,
	useCheckEmail,
} from "./use-check-email";
// Login hook
export {
	type LoginInput,
	type UseLoginOptions,
	useLogin,
} from "./use-login";
// Logout hook
export {
	type LogoutInput,
	type UseLogoutOptions,
	useLock,
	useLogout,
} from "./use-logout";
// Quick unlock hook (password unlock with stored secret key)
export {
	type QuickUnlockInput,
	type UseQuickUnlockOptions,
	useQuickUnlock,
} from "./use-quick-unlock";
// Session state hook
export {
	type UseSessionStateOptions,
	useSessionState,
} from "./use-session-state";
