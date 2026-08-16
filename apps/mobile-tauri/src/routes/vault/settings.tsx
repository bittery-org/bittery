/**
 * Settings. Ported from `apps/mobile/src/screens/settings-screen.tsx` — same sections, same
 * order, same device-wide semantics, rebuilt out of the grouped-card kit.
 *
 * The two switches here are deliberately **device-wide**: `AccountStore` stores biometric
 * enablement and the auto-lock timeout per account, so the fan-out over every account
 * happens at these call sites, where "this applies to every account on this device" is
 * visible and reviewable, rather than hidden below the storage seam.
 */

import { toast } from "@bittery/ui";
import {
	IconCheck,
	IconCircleAlert,
	IconClock,
	IconFingerprint,
	IconLock,
	IconLogOut,
	IconMoon,
	IconNetwork,
	IconSun,
	IconTrash,
	IconTriangleAlert,
} from "@bittery/ui/icons";
import { cn } from "@bittery/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTheme } from "next-themes";
import { useState } from "react";
import { InlineNotice } from "@/components/auth-kit";
import {
	AccountAvatar,
	ConfirmSheet,
	getAccountLabel,
	IconTile,
	iconClass,
	ListCard,
	ListRow,
	MobileSheet,
	Pressable,
	SectionLabel,
	Switch,
} from "@/components/ui";
import { TabScreen } from "@/components/vault/tab-screen";
import { TravelModeRow } from "@/components/vault/travel-mode-sheet";
import { useAccount } from "@/contexts/account-context";
import {
	isAvailable as isCredentialProviderAvailable,
	setMukAutoLockTimeout,
} from "@/lib/credential-provider";
import {
	type AccountMetadata,
	DEFAULT_AUTO_LOCK_TIMEOUT_MS,
	storage,
} from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/vault/settings")({
	component: SettingsScreen,
});

interface DeviceSettings {
	hasBiometricHardware: boolean;
	isBiometricEnrolled: boolean;
	isBiometricEnabled: boolean;
	/** The neutral token `AccountStore` reports: `face`, `fingerprint`, `iris`, `biometric`. */
	biometricType: string | null;
	autoLockTimeout: number;
	serverUrl: string | null;
	masterPasswordDaysRemaining: number | null;
}

const SETTINGS_FALLBACK: DeviceSettings = {
	hasBiometricHardware: false,
	isBiometricEnrolled: false,
	isBiometricEnabled: false,
	biometricType: null,
	autoLockTimeout: DEFAULT_AUTO_LOCK_TIMEOUT_MS,
	serverUrl: null,
	masterPasswordDaysRemaining: null,
};

const DAY_MS = 24 * 60 * 60 * 1000;

function SettingsScreen() {
	const navigate = useNavigate();
	const { m } = useI18n();
	const queryClient = useQueryClient();
	const {
		activeAccount,
		allAccounts,
		refreshAccounts,
		removeAccount,
		lockAllAccounts,
	} = useAccount();
	const { resolvedTheme, setTheme } = useTheme();

	const [isAutoLockOpen, setIsAutoLockOpen] = useState(false);
	const [isConfirmingSignOut, setIsConfirmingSignOut] = useState(false);
	const [accountPendingRemoval, setAccountPendingRemoval] =
		useState<AccountMetadata | null>(null);

	// `next-themes` resolves in an effect, so the first paint has no value yet. The class it
	// already put on <html> carries the same fact, and reading it costs nothing.
	const isDarkMode = resolvedTheme
		? resolvedTheme === "dark"
		: document.documentElement.classList.contains("dark");

	const autoLockOptions = [
		{ label: m.mob_settings_auto_lock_1_min(), value: 60 * 1000 },
		{ label: m.mob_settings_auto_lock_5_min(), value: 5 * 60 * 1000 },
		{ label: m.mob_settings_auto_lock_10_min(), value: 10 * 60 * 1000 },
		{ label: m.mob_settings_auto_lock_30_min(), value: 30 * 60 * 1000 },
		{ label: m.mob_settings_auto_lock_1_hour(), value: 60 * 60 * 1000 },
		{ label: m.mob_settings_auto_lock_never(), value: -1 },
	];

	const settingsKey = [
		"mobile-device-settings",
		activeAccount?.accountId ?? null,
		allAccounts.length,
	];

	const settingsQuery = useQuery<DeviceSettings>({
		queryKey: settingsKey,
		enabled: allAccounts.length > 0,
		queryFn: async () => {
			const fallbackAccountId =
				activeAccount?.accountId || allAccounts[0]?.accountId;

			const details = await storage.getBiometricAvailabilityDetails();
			const biometricType = await storage.getBiometricType();
			const isBiometricEnabled =
				await storage.isBiometricEnabled(fallbackAccountId);
			const autoLockTimeout =
				await storage.getAutoLockTimeoutOrDefault(fallbackAccountId);

			let serverUrl: string | null = null;
			let masterPasswordDaysRemaining: number | null = null;

			if (activeAccount) {
				serverUrl = await storage.getServerUrl(activeAccount.accountId);

				const sessionData = await storage.getStoredSessionData(
					activeAccount.accountId,
				);
				if (sessionData) {
					// The stored period, not the compiled-in constant: `AccountStore` persists it
					// globally and applies that value, so reading it back is the only way this
					// countdown cannot disagree with the policy that actually fires.
					const periodMs = await storage.getMasterPasswordReentryPeriodMs();
					const lastEntry =
						sessionData.lastMasterPasswordEntry || sessionData.createdAt;
					masterPasswordDaysRemaining = Math.max(
						0,
						Math.ceil((lastEntry + periodMs - Date.now()) / DAY_MS),
					);
				}
			}

			return {
				hasBiometricHardware: details.hasHardware,
				isBiometricEnrolled: details.isEnrolled,
				isBiometricEnabled,
				biometricType,
				autoLockTimeout,
				serverUrl,
				masterPasswordDaysRemaining,
			};
		},
	});

	const settings = settingsQuery.data ?? SETTINGS_FALLBACK;
	const isBiometricAvailable =
		settings.hasBiometricHardware && settings.isBiometricEnrolled;

	// The port may report a type it cannot name, or none at all; both collapse to the
	// generic label so the row never renders a raw token.
	const biometricTypeLabel =
		{
			face: m.mob_biometric_type_face(),
			fingerprint: m.mob_biometric_type_fingerprint(),
			iris: m.mob_biometric_type_iris(),
		}[settings.biometricType ?? ""] ?? m.mob_biometric_type_generic();

	const patchSettings = (patch: Partial<DeviceSettings>) => {
		queryClient.setQueryData<DeviceSettings>(settingsKey, (current) => ({
			...(current ?? SETTINGS_FALLBACK),
			...patch,
		}));
	};

	const handleThemeToggle = (nextIsDark: boolean) => {
		setTheme(nextIsDark ? "dark" : "light");
	};

	const handleBiometricToggle = async (value: boolean) => {
		if (allAccounts.length === 0) return;
		const fallbackAccountId =
			activeAccount?.accountId || allAccounts[0]?.accountId;

		try {
			if (value) {
				// Verify biometric before enabling. The prompt reason reaches the OS dialog,
				// so it has to be translated copy from up here.
				const success = await storage.authenticateWithBiometric(
					m.mob_settings_biometric_verify_prompt(),
					fallbackAccountId,
				);
				if (!success) {
					toast.error(m.mob_settings_biometric_error());
					return;
				}
			}
			for (const account of await storage.getAccountsList()) {
				await storage.setBiometricEnabled(account.accountId, value);
			}
			patchSettings({ isBiometricEnabled: value });
		} catch (error) {
			console.error("Error toggling biometric:", error);
			toast.error(m.mob_settings_biometric_settings_error());
		}
	};

	const handleAutoLockSelect = async (value: number) => {
		setIsAutoLockOpen(false);
		if (allAccounts.length === 0) return;

		const accounts = await storage.getAccountsList();
		for (const account of accounts) {
			await storage.storeAutoLockTimeout(value, account.accountId);
		}
		patchSettings({ autoLockTimeout: value });

		// The native autofill provider keeps its own copy of the timeout, so it has to be
		// told separately or autofill stays unlocked after the app has locked. No platform
		// check needed here — `isAvailable()` already answers false where the plugin is not
		// installed, which is what RN's `Platform.OS === "android"` guard stood for.
		if (await isCredentialProviderAvailable()) {
			for (const account of accounts) {
				const sessionData = await storage.getStoredSessionData(
					account.accountId,
				);
				if (sessionData?.userId) {
					await setMukAutoLockTimeout(value, sessionData.userId);
				}
			}
		}
	};

	const handleLock = async () => {
		// Lock, don't sign out: every in-memory master unlock key is dropped, but
		// `session_data` stays, so quick-unlock still works afterwards.
		await lockAllAccounts();
		await navigate({ to: "/unlock" });
	};

	const handleSignOut = async () => {
		setIsConfirmingSignOut(false);
		// Removal, not a session end: this drops the account from the device entirely,
		// which is what "sign out" has always meant on mobile.
		const outcome = activeAccount
			? await removeAccount(activeAccount.accountId)
			: null;
		await refreshAccounts();
		// A promoted successor is left locked, so it needs unlocking, not login.
		await navigate({
			to: outcome && outcome.remaining.length > 0 ? "/unlock" : "/login",
		});
	};

	const handleRemoveAccount = async (account: AccountMetadata) => {
		setAccountPendingRemoval(null);
		// `outcome.remaining`, not the `allAccounts` snapshot this handler closed over —
		// that one still counts the account just removed.
		const outcome = await removeAccount(account.accountId);
		if (outcome.remaining.length === 0) {
			await navigate({ to: "/login" });
		}
	};

	const accountFallback = m.mob_settings_account_fallback();
	const accountLabel = activeAccount
		? getAccountLabel(activeAccount, accountFallback)
		: accountFallback;
	const autoLockLabel =
		autoLockOptions.find((option) => option.value === settings.autoLockTimeout)
			?.label ?? m.mob_settings_auto_lock_10_min();
	const otherAccounts = allAccounts.filter(
		(account) => account.accountId !== activeAccount?.accountId,
	);

	return (
		<TabScreen
			title={m.mob_settings_title()}
			activeTab="settings"
			overlay={
				<>
					<MobileSheet
						open={isAutoLockOpen}
						onOpenChange={setIsAutoLockOpen}
						title={m.mob_settings_auto_lock_dialog_title()}
						description={m.mob_settings_auto_lock_dialog_description()}
					>
						<div className="flex flex-col px-4 pt-1 pb-6">
							{autoLockOptions.map((option) => {
								const isCurrent = option.value === settings.autoLockTimeout;
								return (
									<Pressable
										key={option.value}
										surface="sheet"
										onClick={() => void handleAutoLockSelect(option.value)}
										className={cn(
											"flex h-12 w-full items-center gap-3 rounded-xl px-3",
											isCurrent && "bg-selected",
										)}
									>
										<span className="min-w-0 flex-1 truncate text-left font-medium text-base text-foreground">
											{option.label}
										</span>
										{isCurrent ? (
											<IconCheck
												className={cn(iconClass.row, "shrink-0 text-primary")}
											/>
										) : null}
									</Pressable>
								);
							})}
						</div>
					</MobileSheet>

					<ConfirmSheet
						open={isConfirmingSignOut}
						onOpenChange={setIsConfirmingSignOut}
						title={m.mob_settings_sign_out()}
						description={m.mob_settings_sign_out_description()}
						confirmLabel={m.mob_settings_sign_out()}
						cancelLabel={m.mob_settings_cancel()}
						onConfirm={() => void handleSignOut()}
					/>

					<ConfirmSheet
						open={accountPendingRemoval !== null}
						onOpenChange={(open) => {
							if (!open) setAccountPendingRemoval(null);
						}}
						title={m.mob_settings_remove_account_title()}
						description={
							accountPendingRemoval
								? m.mob_settings_remove_account_message({
										email: accountPendingRemoval.email,
									})
								: undefined
						}
						confirmLabel={m.mob_settings_remove_account_confirm()}
						cancelLabel={m.mob_settings_cancel()}
						onConfirm={() => {
							if (accountPendingRemoval) {
								void handleRemoveAccount(accountPendingRemoval);
							}
						}}
					/>
				</>
			}
		>
			<div className="flex flex-col gap-6 px-4 pt-1">
				<section>
					<SectionLabel>{m.mob_settings_section_account()}</SectionLabel>
					<ListCard>
						<ListRow
							title={accountLabel}
							subtitle={activeAccount?.email}
							leading={<AccountAvatar account={activeAccount} />}
						/>
						<ListRow
							title={m.mob_settings_server_label()}
							subtitle={settings.serverUrl ?? m.mob_settings_server_not_set()}
							leading={
								<IconTile>
									<IconNetwork className={iconClass.row} />
								</IconTile>
							}
						/>
					</ListCard>
				</section>

				<section>
					<SectionLabel>{m.mob_settings_section_appearance()}</SectionLabel>
					<ListCard>
						<ListRow
							title={m.mob_settings_dark_mode()}
							subtitle={
								isDarkMode
									? m.mob_settings_enabled()
									: m.mob_settings_disabled()
							}
							leading={
								<IconTile>
									{isDarkMode ? (
										<IconMoon className={iconClass.row} />
									) : (
										<IconSun className={iconClass.row} />
									)}
								</IconTile>
							}
							trailing={
								<Switch
									isSelected={isDarkMode}
									onSelectedChange={handleThemeToggle}
									ariaLabel={m.mob_settings_dark_mode()}
								/>
							}
						/>
					</ListCard>
				</section>

				<section>
					<SectionLabel>{m.mob_settings_section_security()}</SectionLabel>
					<ListCard>
						{isBiometricAvailable ? (
							<ListRow
								title={m.mob_settings_biometric_unlock({
									biometricType: biometricTypeLabel,
								})}
								subtitle={
									settings.isBiometricEnabled
										? m.mob_settings_enabled()
										: m.mob_settings_disabled()
								}
								leading={
									<IconTile>
										<IconFingerprint className={iconClass.row} />
									</IconTile>
								}
								trailing={
									<Switch
										isSelected={settings.isBiometricEnabled}
										onSelectedChange={(value) =>
											void handleBiometricToggle(value)
										}
										ariaLabel={m.mob_settings_biometric_unlock({
											biometricType: biometricTypeLabel,
										})}
									/>
								}
							/>
						) : null}
						<ListRow
							title={m.mob_settings_auto_lock_label()}
							subtitle={autoLockLabel}
							leading={
								<IconTile>
									<IconClock className={iconClass.row} />
								</IconTile>
							}
							onPress={() => setIsAutoLockOpen(true)}
							showChevron
						/>
						<ListRow
							title={m.mob_settings_lock_vault()}
							leading={
								<IconTile>
									<IconLock className={iconClass.row} />
								</IconTile>
							}
							onPress={() => void handleLock()}
							compact
							showChevron
						/>
						{/* One row per account, not one device-wide switch: travel mode is a
						    server-side per-account flag, unlike the two settings above it. */}
						{allAccounts.map((account) => (
							<TravelModeRow
								key={account.accountId}
								accountId={account.accountId}
								accountLabel={getAccountLabel(account, accountFallback)}
								showAccountLabel={allAccounts.length > 1}
							/>
						))}
					</ListCard>
					<p className="px-1 pt-2 text-muted-foreground text-xs">
						{m.mob_settings_security_hint()}
					</p>

					{settings.hasBiometricHardware ? null : (
						<InlineNotice
							className="mt-2"
							tone="neutral"
							icon={IconCircleAlert}
							title={m.mob_settings_biometric_not_available_title()}
							description={m.mob_settings_biometric_not_available_description()}
						/>
					)}
					{settings.hasBiometricHardware && !settings.isBiometricEnrolled ? (
						<InlineNotice
							className="mt-2"
							tone="warning"
							icon={IconTriangleAlert}
							title={m.mob_settings_biometric_setup_title()}
							description={m.mob_settings_biometric_setup_description()}
						/>
					) : null}
					{settings.isBiometricEnabled &&
					settings.masterPasswordDaysRemaining !== null ? (
						<InlineNotice
							className="mt-2"
							tone="brand"
							icon={IconLock}
							title={m.mob_settings_password_check_title()}
							description={
								settings.masterPasswordDaysRemaining > 0
									? m.mob_settings_password_check_days_remaining({
											days: String(settings.masterPasswordDaysRemaining),
										})
									: m.mob_settings_password_check_now()
							}
						/>
					) : null}
				</section>

				<section>
					<SectionLabel>{m.mob_settings_section_data()}</SectionLabel>
					<ListCard>
						{/* Trash left the tab bar with the 5→3 tab change; this is one of its two
						    remaining doors, the other being the account sheet. */}
						<ListRow
							title={m.mob_tab_trash()}
							subtitle={m.mob_settings_trash_value()}
							leading={
								<IconTile>
									<IconTrash className={iconClass.row} />
								</IconTile>
							}
							onPress={() => void navigate({ to: "/vault/trash" })}
							showChevron
						/>
					</ListCard>
				</section>

				{otherAccounts.length > 0 ? (
					<section>
						<SectionLabel>
							{m.mob_settings_section_other_accounts()}
						</SectionLabel>
						<ListCard>
							{otherAccounts.map((account) => (
								<ListRow
									key={account.accountId}
									title={getAccountLabel(account, accountFallback)}
									subtitle={account.email}
									leading={<AccountAvatar account={account} />}
									onPress={() => setAccountPendingRemoval(account)}
									trailing={
										<IconTrash className={cn(iconClass.row, "text-danger")} />
									}
								/>
							))}
						</ListCard>
					</section>
				) : null}

				<section>
					<SectionLabel>{m.mob_settings_section_about()}</SectionLabel>
					<ListCard>
						<ListRow
							title={m.mob_settings_app_name()}
							value={m.mob_settings_app_version()}
							leading={
								<IconTile>
									<IconCircleAlert className={iconClass.row} />
								</IconTile>
							}
							compact
						/>
					</ListCard>
					<InlineNotice
						className="mt-2"
						tone="neutral"
						icon={IconCircleAlert}
						title={m.mob_settings_accessibility_title()}
						description={m.mob_settings_accessibility_description()}
					/>
				</section>

				<section>
					<SectionLabel>{m.mob_settings_section_danger()}</SectionLabel>
					<ListCard>
						<ListRow
							title={m.mob_settings_sign_out()}
							subtitle={m.mob_settings_sign_out_value()}
							tone="danger"
							leading={
								<IconTile tone="danger">
									<IconLogOut className={iconClass.row} />
								</IconTile>
							}
							onPress={() => setIsConfirmingSignOut(true)}
						/>
					</ListCard>
				</section>
			</div>
		</TabScreen>
	);
}
