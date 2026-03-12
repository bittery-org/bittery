import type { BiometricErrorType } from "@bittery/storage";

export function resolveBiometricErrorMessage(
	error: BiometricErrorType,
): string {
	switch (error) {
		case "not_available":
			return "This device does not support biometric authentication.";
		case "not_enrolled":
			return "No biometrics are set up on this device. Please configure Face ID or Touch ID in your device settings.";
		case "not_enabled":
			return "Biometric unlock is not enabled for this account. You can enable it in Settings.";
		case "authentication_failed":
			return "Biometric authentication failed. Please try again or use your password.";
		case "user_cancelled":
			return "Authentication was cancelled.";
		case "lockout":
			return "Too many failed attempts. Please use your master password to unlock.";
		case "master_password_required":
			return "For security, please enter your master password. This is required periodically based on your settings.";
		case "session_expired":
			return "Your session has expired. Please log in with your credentials.";
		default:
			return "An error occurred during authentication. Please try again.";
	}
}
