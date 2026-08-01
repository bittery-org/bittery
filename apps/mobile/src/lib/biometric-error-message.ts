/**
 * Biometric failures — the one place a `BiometricErrorType` becomes user-facing copy.
 *
 * `BiometricAuthResult.message` is **diagnostic only**: `AccountStore` fills it with English
 * fallbacks and the react-native port carries the raw native error code through it, so it is
 * for logs and bug reports, never for a screen. Every mobile surface renders from `error`
 * instead, through this function.
 *
 * `master_password_required` is the reason this takes the whole result rather than just the
 * error type: storage publishes the re-entry period as a number
 * (`masterPasswordReentryPeriodMs`) and refuses to format the sentence, so the days figure is
 * interpolated into a translated message here rather than concatenated anywhere.
 */

import type { m as messages } from "@bittery/i18n/paraglide/messages";
import type { BiometricErrorType } from "@bittery/storage";

/** The message module, as this helper uses it. */
type Messages = typeof messages;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The subset of `BiometricAuthResult` this function reads.
 *
 * Structural rather than the full result type so the `useBiometricUnlock` error shape —
 * which carries a `type` and no period — can be adapted at the call site without a cast.
 */
export interface BiometricErrorDetail {
	error?: BiometricErrorType;
	masterPasswordReentryPeriodMs?: number;
}

/**
 * `undefined` when storage did not publish a period, or published one that does not round to
 * a whole number of days (a negative period means "never re-ask"). The caller then renders
 * the period-free variant instead of an "every 0 days" sentence.
 */
function reentryPeriodInDays(periodMs: number | undefined): number | undefined {
	if (periodMs === undefined || periodMs <= 0) {
		return undefined;
	}
	const days = Math.round(periodMs / MS_PER_DAY);
	return days > 0 ? days : undefined;
}

/**
 * The translated sentence for "your master password is due again", with the real period when
 * storage published one. Exported because the biometric modal shows the same fact in its
 * dedicated password-required state, and the two must not drift.
 */
export function resolveMasterPasswordReentryMessage(
	periodMs: number | undefined,
	m: Messages,
): string {
	const days = reentryPeriodInDays(periodMs);
	return days === undefined
		? m.mob_biometric_modal_password_required_description()
		: m.mob_biometric_modal_password_required_description_days({
				days: String(days),
			});
}

export function resolveBiometricErrorMessage(
	detail: BiometricErrorDetail,
	m: Messages,
): string {
	switch (detail.error) {
		case "not_available":
			return m.mob_biometric_error_not_available();
		case "not_enrolled":
			return m.mob_biometric_error_not_enrolled();
		case "not_enabled":
			return m.mob_biometric_error_not_enabled();
		case "authentication_failed":
			return m.mob_biometric_error_auth_failed();
		// The react-native port maps the native `user_cancel` / `lockout` / `lockout_permanent`
		// codes onto the port's closed set, so `user_cancelled` and `lockout` must stay
		// distinguishable here. Cancelling is not a failure and the copy says so; a lockout
		// is terminal and sends the user to their password.
		case "user_cancelled":
			return m.mob_biometric_error_user_cancelled();
		case "lockout":
			return m.mob_biometric_error_lockout();
		case "master_password_required": {
			const days = reentryPeriodInDays(detail.masterPasswordReentryPeriodMs);
			return days === undefined
				? m.mob_biometric_error_master_password_required()
				: m.mob_biometric_error_master_password_required_days({
						days: String(days),
					});
		}
		case "session_expired":
			return m.mob_biometric_error_session_expired();
		case "account_not_found":
			return m.mob_biometric_error_account_not_found();
		default:
			return m.mob_biometric_error_unknown();
	}
}
