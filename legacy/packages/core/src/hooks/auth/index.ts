/**
 * Auth Hooks
 *
 * React hooks for authentication operations.
 * These hooks wrap the core auth utilities with React Query
 * for state management and caching.
 */

// Account metadata sync hooks
export { useAccountMetadataSyncAll } from "./use-account-metadata-sync";
// Account switcher hook (multi-account management)
export {
	type UseAccountSwitcherOptions,
	type UseAccountSwitcherResult,
	useAccountSwitcher,
} from "./use-account-switcher";
// Biometric unlock hook (Touch ID / Face ID)
export {
	type BiometricUnlockError,
	type BiometricUnlockInput,
	type BiometricUnlockResult,
	type UseBiometricUnlockOptions,
	useBiometricUnlock,
} from "./use-biometric-unlock";
// Login hook
export {
	type LoginInput,
	type UseLoginOptions,
	useLogin,
} from "./use-login";
// Quick unlock hook (password unlock with stored secret key)
export {
	type QuickUnlockInput,
	type QuickUnlockResult,
	type UseQuickUnlockOptions,
	useQuickUnlock,
} from "./use-quick-unlock";
// Quick unlock all hook (unlock all accounts with single password)
export {
	type QuickUnlockAllInput,
	type QuickUnlockAllResult,
	type UseQuickUnlockAllOptions,
	useQuickUnlockAll,
} from "./use-quick-unlock-all";
// Session state hook
export {
	type UseSessionStateOptions,
	useSessionState,
} from "./use-session-state";
