/**
 * Auth Hooks
 *
 * React hooks for authentication operations.
 * These hooks wrap the core auth utilities with React Query
 * for state management and caching.
 */

// Login hook
export {
	useLogin,
	type UseLoginOptions,
	type LoginInput,
} from "./use-login";

// Quick unlock hook (password unlock with stored secret key)
export {
	useQuickUnlock,
	type UseQuickUnlockOptions,
	type QuickUnlockInput,
} from "./use-quick-unlock";

// Biometric unlock hook (Touch ID / Face ID)
export {
	useBiometricUnlock,
	type UseBiometricUnlockOptions,
	type BiometricUnlockInput,
	type BiometricUnlockError,
	type BiometricUnlockResult,
} from "./use-biometric-unlock";

// Check email hook
export {
	useCheckEmail,
	type UseCheckEmailOptions,
} from "./use-check-email";

// Session state hook
export {
	useSessionState,
	type UseSessionStateOptions,
} from "./use-session-state";

// Logout hook
export {
	useLogout,
	useLock,
	type UseLogoutOptions,
	type LogoutInput,
} from "./use-logout";
