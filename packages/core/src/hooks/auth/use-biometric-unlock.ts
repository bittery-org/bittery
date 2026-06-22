/**
 * useBiometricUnlock Hook
 *
 * React hook for performing biometric unlock (Touch ID / Face ID).
 * Desktop and mobile only - web/extension don't support biometric.
 */

import type { BiometricAuthResult } from "@bittery/storage";
import { resolveAccountScopeId } from "@bittery/storage/account-id";
import { type UseMutationResult, useMutation } from "@tanstack/react-query";
import { usePlatformStorage } from "../../context/platform-context";

/**
 * Options for useBiometricUnlock hook
 */
export interface UseBiometricUnlockOptions {
	/**
	 * Callback when biometric unlock succeeds.
	 */
	onSuccess?: () => void | Promise<void>;

	/**
	 * Callback when biometric unlock fails.
	 */
	onError?: (error: BiometricUnlockError) => void;

	/**
	 * Prompt message shown during biometric authentication.
	 * Defaults to "Unlock Bittery"
	 */
	promptMessage?: string;
}

/**
 * Input for biometric unlock
 */
export interface BiometricUnlockInput {
	/**
	 * Account ID or email for multi-account platforms.
	 * Optional - uses active account if not provided.
	 */
	accountIdOrEmail?: string;
}

/**
 * Biometric unlock error with structured error type
 */
export interface BiometricUnlockError {
	type:
		| "not_available"
		| "not_enrolled"
		| "not_enabled"
		| "master_password_required"
		| "session_expired"
		| "user_cancelled"
		| "lockout"
		| "authentication_failed"
		| "unknown";
	message: string;
}

/**
 * Result from biometric unlock
 */
export interface BiometricUnlockResult {
	success: boolean;
}

/**
 * Hook for performing biometric unlock.
 *
 * @example
 * ```tsx
 * const biometricUnlock = useBiometricUnlock({
 *   onSuccess: () => navigate('/vault'),
 *   onError: (error) => {
 *     if (error.type === 'master_password_required') {
 *       showPasswordPrompt();
 *     } else {
 *       toast.error(error.message);
 *     }
 *   },
 * });
 *
 * // Check if biometric is available
 * const canUseBiometric = await storage.canBiometricUnlock();
 * if (canUseBiometric) {
 *   biometricUnlock.mutate({});
 * }
 * ```
 */
export function useBiometricUnlock(
	options: UseBiometricUnlockOptions = {},
): UseMutationResult<
	BiometricUnlockResult,
	BiometricUnlockError,
	BiometricUnlockInput
> {
	const storage = usePlatformStorage();

	return useMutation({
		mutationFn: async (input: BiometricUnlockInput) => {
			const accountId = await resolveAccountScopeId(
				storage,
				input.accountIdOrEmail,
			);
			if (!accountId) {
				throw {
					type: "unknown",
					message: "No account found for biometric unlock",
				} as BiometricUnlockError;
			}

			// Check if biometric is supported
			if (!storage.supportsBiometric) {
				throw {
					type: "not_available",
					message: "Biometric authentication is not supported on this platform",
				} as BiometricUnlockError;
			}

			// Check if master password re-entry is required by policy
			// This check happens before biometric auth for better UX
			if (storage.isMasterPasswordReentryRequired) {
				const requiresReentry =
					await storage.isMasterPasswordReentryRequired(accountId);
				if (requiresReentry) {
					throw {
						type: "master_password_required",
						message:
							"For security, please enter your master password. This is required periodically based on your settings.",
					} as BiometricUnlockError;
				}
			}

			// Use enhanced biometric auth if available for better error handling
			if (storage.authenticateWithBiometricEnhanced) {
				const result: BiometricAuthResult =
					await storage.authenticateWithBiometricEnhanced(
						options.promptMessage ?? "Unlock Bittery",
						accountId,
					);

				if (!result.success) {
					throw {
						type: result.error ?? "unknown",
						message: result.message ?? "Biometric authentication failed",
					} as BiometricUnlockError;
				}

				// Now try to restore the MUK using biometric unlock
				if (storage.unlockWithBiometric) {
					const unlocked = await storage.unlockWithBiometric(accountId);
					if (!unlocked) {
						throw {
							type: "authentication_failed",
							message: "Failed to unlock vault after biometric authentication",
						} as BiometricUnlockError;
					}
				}

				return { success: true };
			}

			// Fallback to simple biometric unlock
			if (storage.unlockWithBiometric) {
				const success = await storage.unlockWithBiometric(accountId);
				if (!success) {
					throw {
						type: "authentication_failed",
						message: "Biometric unlock failed",
					} as BiometricUnlockError;
				}
				return { success: true };
			}

			// No biometric unlock method available
			throw {
				type: "not_available",
				message: "Biometric unlock is not available",
			} as BiometricUnlockError;
		},
		onSuccess: () => {
			options.onSuccess?.();
		},
		onError: (error) => {
			options.onError?.(error);
		},
	});
}
