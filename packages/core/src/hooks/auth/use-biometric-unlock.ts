/**
 * useBiometricUnlock Hook
 *
 * React hook for performing biometric unlock (Touch ID / Face ID).
 * Desktop and mobile only - web/extension don't support biometric.
 */

import { m } from "@bittery/i18n/paraglide/messages";
import type { BiometricAuthResult, BiometricErrorType } from "@bittery/storage";
import { type UseMutationResult, useMutation } from "@tanstack/react-query";
import {
	usePlatformItemCache,
	usePlatformStorage,
} from "../../context/platform-context";
import { createStoredAccountRpcClient } from "../../services/rpc-client";
import { getTravelModeEnforcer } from "../../services/travel-mode-enforcer";

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
	accountId?: string;
}

/**
 * Biometric unlock error with structured error type
 */
export interface BiometricUnlockError {
	type: BiometricErrorType;
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
	const itemCache = usePlatformItemCache();

	const verifyTravelMode = async (accountId: string): Promise<void> => {
		const client = await createStoredAccountRpcClient(storage, accountId).catch(
			() => null,
		);
		const verified = await getTravelModeEnforcer(
			storage,
			itemCache,
		).verifyOrClear(accountId, client);
		if (!verified) {
			throw {
				type: "authentication_failed",
				message: m.auth_error_travel_mode_verify_failed(),
			} as BiometricUnlockError;
		}
	};

	return useMutation({
		mutationFn: async (input: BiometricUnlockInput) => {
			const accountId = input.accountId;
			if (!accountId) {
				throw {
					type: "account_not_found",
					message: "",
				} as BiometricUnlockError;
			}

			if (!(await storage.isBiometricAvailable())) {
				throw {
					type: "not_available",
					message: "Biometric authentication is not available on this device",
				} as BiometricUnlockError;
			}

			// Check if master password re-entry is required by policy
			// This check happens before biometric auth for better UX
			if (await storage.isMasterPasswordReentryRequired(accountId)) {
				throw {
					type: "master_password_required",
					message:
						"For security, please enter your master password. This is required periodically based on your settings.",
				} as BiometricUnlockError;
			}

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

			// Now restore the MUK using biometric unlock. The prompt normally does not
			// re-appear here (the call above just refreshed the biometric grace window), but
			// the reason is threaded through anyway: if it ever does appear, the OS must not
			// show `AccountStore`'s English fallback in place of the caller's translated
			// prompt.
			const unlocked = await storage.unlockWithBiometric(
				accountId,
				options.promptMessage,
			);
			if (!unlocked) {
				throw {
					type: "authentication_failed",
					message: "Failed to unlock vault after biometric authentication",
				} as BiometricUnlockError;
			}

			await verifyTravelMode(accountId);

			return { success: true };
		},
		onSuccess: () => {
			options.onSuccess?.();
		},
		onError: (error) => {
			options.onError?.(error);
		},
	});
}
