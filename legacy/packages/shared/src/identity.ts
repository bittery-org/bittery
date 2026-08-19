/**
 * Identity utilities for formatting and masking personal information
 */

export interface Address {
	id: string;
	street: string;
	city: string;
	state: string;
	zip: string;
	country: string;
}

export interface PhoneNumber {
	id: string;
	label: string;
	number: string;
}

/**
 * Mask SSN for display (shows last 4 digits)
 * Example: 123-45-6789 -> ***-**-6789
 */
export function maskSSN(ssn: string): string {
	const cleaned = ssn.replace(/\D/g, "");
	if (cleaned.length < 4) {
		return "***-**-****";
	}
	const last4 = cleaned.slice(-4);
	return `***-**-${last4}`;
}

/**
 * Format SSN as XXX-XX-XXXX
 */
export function formatSSN(ssn: string): string {
	const cleaned = ssn.replace(/\D/g, "");
	if (cleaned.length === 9) {
		return `${cleaned.slice(0, 3)}-${cleaned.slice(3, 5)}-${cleaned.slice(5)}`;
	}
	return ssn;
}

/**
 * Mask passport number (shows last 4 characters)
 */
export function maskPassportNumber(passport: string): string {
	if (passport.length < 4) {
		return "••••";
	}
	const last4 = passport.slice(-4);
	return `••••${last4}`;
}

/**
 * Mask driver's license (shows last 4 characters)
 */
export function maskDriversLicense(license: string): string {
	if (license.length < 4) {
		return "••••";
	}
	const last4 = license.slice(-4);
	return `••••${last4}`;
}

/**
 * Format phone number
 * Simple formatting - handles US 10-digit format
 */
export function formatPhoneNumber(phone: string): string {
	const cleaned = phone.replace(/\D/g, "");

	// US format: (XXX) XXX-XXXX
	if (cleaned.length === 10) {
		return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
	}

	// International or other formats - return as-is
	return phone;
}

/**
 * Format address as single string
 */
export function formatAddress(address: Address): string {
	const parts = [
		address.street,
		address.city,
		address.state,
		address.zip,
		address.country,
	].filter(Boolean);

	return parts.join(", ");
}
