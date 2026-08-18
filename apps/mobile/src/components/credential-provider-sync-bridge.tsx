/**
 * The call site `apps/mobile/app/_layout.tsx:42` had, moved to a router-independent
 * component.
 *
 * Expo could call the hook straight from its root layout because expo-router's `Stack`
 * rendered *inside* the provider tree. TanStack's `RouterProvider` is a leaf of that tree
 * here, so there is no root component below the providers to hang the hook on — hence a
 * component of its own, rendered as `RouterProvider`'s sibling inside
 * `MobilePlatformProvider`. It renders nothing; it exists so the hook runs on every route,
 * which is what "regardless of active route" meant in the original.
 */

import { useCredentialProviderSync } from "@/hooks/use-credential-provider-sync";

/**
 * The Expo call site gated on `Platform.OS === "android" && EXPO_PUBLIC_… !== "true"`.
 * The platform half is dropped: the credential-provider plugin only exists in the Android
 * build, so the hook's own availability probe answers it and answering it twice would only
 * add a way for the two answers to disagree. The escape hatch stays, under a Vite name.
 */
const CREDENTIAL_SYNC_ENABLED =
	import.meta.env.VITE_DISABLE_ANDROID_CREDENTIAL_SYNC !== "true";

export function CredentialProviderSyncBridge() {
	// Keep Android credential-provider data in sync regardless of active route.
	useCredentialProviderSync({
		enabled: CREDENTIAL_SYNC_ENABLED,
		autoSync: CREDENTIAL_SYNC_ENABLED,
		debounceMs: import.meta.env.DEV ? 5000 : 3000,
	});

	return null;
}
