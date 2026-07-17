import type { BiometricErrorType } from "@bittery/storage";

export function resolveBiometricErrorMessage(
	error: BiometricErrorType,
	m: any,
): string {
	switch (error) {
		case "not_available":
			return m.mob_biometric_error_not_available();
		case "not_enrolled":
			return m.mob_biometric_error_not_enrolled();
		case "not_enabled":
			return m.mob_biometric_error_not_enabled();
		case "authentication_failed":
			return m.mob_biometric_error_auth_failed();
		case "user_cancelled":
			return m.mob_biometric_error_user_cancelled();
		case "lockout":
			return m.mob_biometric_error_lockout();
		case "master_password_required":
			return m.mob_biometric_error_master_password_required();
		case "session_expired":
			return m.mob_biometric_error_session_expired();
		case "account_not_found":
			return m.mob_biometric_error_account_not_found();
		default:
			return m.mob_biometric_error_unknown();
	}
}
