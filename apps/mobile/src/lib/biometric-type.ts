/**
 * Biometric type — the one place the storage token becomes user-facing copy.
 *
 * `AccountStore.getBiometricType()` returns a neutral token (`"face"`, `"fingerprint"`,
 * `"iris"`, `"biometric"`, or `null` when the platform cannot tell), and this module maps
 * that token to a translated label and to the icon the five biometric screens draw.
 */

import type { m as messages } from "@bittery/i18n/paraglide/messages";
import { useQuery } from "@tanstack/react-query";
import { useI18n } from "@/providers/i18n-provider";
import { storage } from "@/services/storage";

/** The closed set of tokens `getBiometricType()` may report. */
export type BiometricTypeToken = "face" | "fingerprint" | "iris" | "biometric";

/** The message module, as this helper uses it. */
type Messages = typeof messages;

const TOKENS: readonly BiometricTypeToken[] = [
	"face",
	"fingerprint",
	"iris",
	"biometric",
];

/**
 * Narrow whatever the platform reported onto the closed set.
 *
 * `null` (the port could not determine a type) and any token a future port might add both
 * collapse to `"biometric"`, so the UI always has a label and never renders a raw token.
 */
export function parseBiometricType(raw: string | null): BiometricTypeToken {
	return TOKENS.find((token) => token === raw) ?? "biometric";
}

/** The translated label to interpolate into `{biometricType}` message parameters. */
export function resolveBiometricTypeLabel(
	token: BiometricTypeToken,
	m: Messages,
): string {
	switch (token) {
		case "face":
			return m.mob_biometric_type_face();
		case "fingerprint":
			return m.mob_biometric_type_fingerprint();
		case "iris":
			return m.mob_biometric_type_iris();
		default:
			return m.mob_biometric_type_generic();
	}
}

export interface BiometricTypeInfo {
	/**
	 * The narrowed token, for the one thing a label cannot express: which icon to draw.
	 * The icon components themselves stay at the call sites because each screen styles
	 * them differently (`withUniwind` wrappers on the unlock screens, raw lucide in the
	 * modal), and building them here would mint a new component type on every render.
	 */
	token: BiometricTypeToken;
	/** Already translated; safe to render and to pass as a `{biometricType}` parameter. */
	label: string;
}

/**
 * Read the device's biometric type and return it ready to render.
 *
 * A hook rather than a `useEffect` + `useState` pair: the value is a cached async read
 * of a device fact, which is exactly what `useQuery` is for.
 */
export function useBiometricType(
	options: { enabled?: boolean } = {},
): BiometricTypeInfo {
	const { m } = useI18n();
	const query = useQuery({
		queryKey: ["mobile", "biometric-type"],
		queryFn: () => storage.getBiometricType(),
		enabled: options.enabled ?? true,
	});

	const token = parseBiometricType(query.data ?? null);
	return { token, label: resolveBiometricTypeLabel(token, m) };
}
