import { useQuery } from "@tanstack/react-query";
import { Redirect } from "expo-router";
import { useThemeColor } from "heroui-native";
import { ActivityIndicator, Text, View } from "react-native";
import { BrandLockup } from "@/components/auth-kit";
import { Screen } from "@/components/ui";
import { useAccount } from "@/contexts/account-context";
import { useBiometricAuth } from "@/contexts/biometric-auth-context";
import { useI18n } from "@/providers/i18n-provider";
import { storage } from "@/services/storage";

const NO_SESSION = { hasValidSession: false, isUnlockKeyAvailable: false };

/** Branded hold while the gate resolves — never a bare spinner on a blank canvas. */
function LaunchSplash({ caption }: { caption?: string }) {
	const [accent] = useThemeColor(["accent"]);

	return (
		<Screen aurora>
			<View className="flex-1 items-center justify-center px-8">
				<BrandLockup />
				<ActivityIndicator
					size="small"
					color={accent}
					style={{ marginTop: 32 }}
				/>
				{caption ? (
					<Text className="mt-4 text-center text-muted text-sm">{caption}</Text>
				) : null}
			</View>
		</Screen>
	);
}

/**
 * The launch gate: decides between full sign-in, quick unlock and the vault.
 * Biometric unlock restores the master unlock key asynchronously, so the gate
 * waits for it rather than letting the item list try to decrypt without it.
 */
export default function Index() {
	const { m } = useI18n();
	const { activeAccount, activeAccountConfig, allAccounts, isLoading } =
		useAccount();
	const { requiresReauth, showAuthModal } = useBiometricAuth();

	// `requiresReauth` is part of the key so that finishing the biometric prompt
	// re-reads the master unlock key instead of stranding the gate on the splash.
	const gate = useQuery({
		queryKey: [
			"mobile",
			"launch-gate",
			activeAccountConfig,
			activeAccount?.accountId ?? null,
			requiresReauth,
		],
		queryFn: async () => {
			if (!activeAccountConfig || !activeAccount) {
				return NO_SESSION;
			}

			const hasValidSession = await storage.isSessionValid(
				activeAccount.accountId,
			);
			if (!hasValidSession) {
				return NO_SESSION;
			}

			// A launch inside the biometric grace period resumes silently; anything that
			// would need a prompt belongs to the unlock screen, which owns the prompt and
			// the retry. Nothing else on this path may unlock.
			await storage.tryRestoreSessionWithoutPrompt(activeAccount.accountId);

			const masterUnlockKey = await storage.getMasterUnlockKey(
				activeAccount.accountId,
			);
			return {
				hasValidSession: true,
				isUnlockKeyAvailable: masterUnlockKey !== null,
			};
		},
		enabled: !isLoading,
		retry: false,
		gcTime: 0,
	});

	if (isLoading || gate.isPending) {
		return <LaunchSplash />;
	}

	// A failed read is indistinguishable from an unusable session: send the user
	// to quick unlock rather than into a vault that cannot decrypt.
	const { hasValidSession, isUnlockKeyAvailable } = gate.data ?? NO_SESSION;

	if (!activeAccountConfig && allAccounts.length === 0) {
		return <Redirect href="/(auth)/login" />;
	}

	if (!hasValidSession) {
		return <Redirect href="/(auth)/unlock" />;
	}

	// Only an in-flight biometric prompt holds the gate; it resolves on its own.
	if (showAuthModal) {
		return <LaunchSplash caption={m.mob_index_authenticating()} />;
	}

	// A locked account has no prompt of its own on a cold launch — the `AppState`
	// listener that raises one only fires on a background/foreground transition — so
	// the gate must hand off to the unlock screen instead of holding the splash.
	if (requiresReauth || !isUnlockKeyAvailable) {
		return <Redirect href="/(auth)/unlock" />;
	}

	return <Redirect href="/(tabs)" />;
}
