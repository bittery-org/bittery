/**
 * useBiometricUnlock Hook
 *
 * React Query wrapper around the shared biometric unlock for a single account.
 * Desktop and mobile only — web/extension have no biometric.
 */

import type { BiometricErrorType } from "@bittery/storage";
import {
	type UseMutationResult,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import {
	usePlatformItemCache,
	usePlatformStorage,
} from "../../context/platform-context";
import {
	type UnlockFailure,
	type UnlockOutcome,
	unlockAccountWithBiometric,
} from "../../services/unlock";

/**
 * Input for biometric unlock
 */
export interface BiometricUnlockInput {
	/** Account to unlock; the OS prompt and the stored key are both per-account. */
	accountId: string;
}

/** Surfaced as-is: consumers read `unlocked` and `failed.length`. */
export type BiometricUnlockResult = UnlockOutcome;

/**
 * Biometric failure as a structured code. No message travels with it: callers own
 * the copy (see `apps/mobile/src/lib/biometric-error-message.ts`) and this package
 * authors none.
 */
export interface BiometricUnlockError {
	/**
	 * Wider than the OS verdict: travel mode can stop an unlock the biometric
	 * itself passed, and `BiometricErrorType` has no member for a policy stop.
	 */
	type: BiometricErrorType | "travel_mode_unverified";
	/** Set with `master_password_required` when storage published a re-entry period. */
	masterPasswordReentryPeriodMs?: number;
}

/**
 * Options for useBiometricUnlock hook
 */
export interface UseBiometricUnlockOptions {
	/**
	 * Callback when biometric unlock succeeds.
	 * Use this for navigation, showing success messages, etc.
	 */
	onSuccess?: (
		result: BiometricUnlockResult,
		input: BiometricUnlockInput,
	) => void | Promise<void>;

	/**
	 * Callback when biometric unlock fails.
	 * Use this for showing error messages.
	 */
	onError?: (error: BiometricUnlockError, input: BiometricUnlockInput) => void;

	/**
	 * Prompt the OS shows. Required and already translated: it is user-facing copy,
	 * which this package must never author.
	 */
	promptMessage: string;
}

function biometricError(
	failure: UnlockFailure | undefined,
): BiometricUnlockError {
	if (failure?.biometric) {
		return {
			type: failure.biometric.error,
			masterPasswordReentryPeriodMs:
				failure.biometric.masterPasswordReentryPeriodMs,
		};
	}
	// The only reason the biometric path reports without an OS verdict: the account
	// is not on this device.
	if (failure?.reason === "no_stored_secret_key") {
		return { type: "account_not_found" };
	}
	// Reported under its own reason because claiming `authentication_failed`
	// would blame the fingerprint for a policy stop.
	if (failure?.reason === "travel_mode_unverified") {
		return { type: "travel_mode_unverified" };
	}
	return { type: "unknown" };
}

/**
 * Hook for unlocking one account with Touch ID / Face ID.
 *
 * @example
 * ```tsx
 * const biometricUnlock = useBiometricUnlock({
 *   promptMessage: m.biometric_prompt_unlock_bittery(),
 *   onSuccess: () => navigate('/vault'),
 *   onError: (error) => {
 *     // Without the period the copy falls back to the variant that cannot name it.
 *     const message = resolveBiometricErrorMessage(
 *       {
 *         error: error.type,
 *         masterPasswordReentryPeriodMs: error.masterPasswordReentryPeriodMs,
 *       },
 *       m,
 *     );
 *     if (error.type === 'master_password_required') {
 *       showPasswordPrompt(message);
 *     } else {
 *       toast.error(message);
 *     }
 *   },
 * });
 *
 * biometricUnlock.mutate({ accountId });
 * ```
 */
export function useBiometricUnlock(
	options: UseBiometricUnlockOptions,
): UseMutationResult<
	BiometricUnlockResult,
	BiometricUnlockError,
	BiometricUnlockInput
> {
	const storage = usePlatformStorage();
	const itemCache = usePlatformItemCache();
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (input: BiometricUnlockInput) => {
			let outcome: BiometricUnlockResult;
			try {
				outcome = await unlockAccountWithBiometric(
					{
						accountId: input.accountId,
						promptMessage: options.promptMessage,
					},
					{ storage, itemCache },
				);
			} catch (error) {
				// Consumers branch on `error.type`, so a raw storage throw would escape as
				// an error this mutation's declared type says cannot happen.
				console.error(
					"[BiometricUnlock] Unlock threw:",
					input.accountId,
					error,
				);
				const unknown: BiometricUnlockError = { type: "unknown" };
				throw unknown;
			}
			// The unlock reports rather than throws; React Query needs a rejection to
			// route a failure to `onError`.
			if (outcome.unlocked.length === 0) {
				throw biometricError(outcome.failed[0]);
			}
			return outcome;
		},
		onSuccess: (result, input) => {
			queryClient.invalidateQueries({ queryKey: ["accounts", "unlocked"] });
			queryClient.invalidateQueries({ queryKey: ["auth"] });
			queryClient.invalidateQueries({ queryKey: ["vaults"] });
			queryClient.invalidateQueries({ queryKey: ["items"] });

			options.onSuccess?.(result, input);
		},
		onError: (error, input) => {
			options.onError?.(error, input);
		},
	});
}
