import { lockAllAccounts } from "@bittery/core/services/account-lifecycle";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { BottomSheet, PressableFeedback, useToast } from "heroui-native";
import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { AccountAvatar, getAccountLabel } from "@/components/auth-kit";
import {
	GlowBar,
	IconCheck,
	IconLock,
	IconPlus,
	IconSettings,
	IconTrash,
	iconSize,
	SectionLabel,
	SheetBrandAccent,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { useI18n } from "@/providers/i18n-provider";
import { useAccount } from "../contexts/account-context";
import { lifecycleDeps } from "../services/lifecycle";
import { type AccountMetadata, storage } from "../services/storage";

/** One of the four verbs the sheet offers below the account list. */
function SheetAction({
	label,
	icon: Icon,
	onPress,
	tone = "default",
}: {
	label: string;
	icon: typeof IconPlus;
	onPress: () => void;
	tone?: "default" | "danger";
}) {
	const isDanger = tone === "danger";

	return (
		<PressableFeedback
			onPress={onPress}
			accessibilityRole="button"
			className="h-14 flex-row items-center gap-3 rounded-xl px-2"
		>
			<PressableFeedback.Highlight />
			<View
				className={cn(
					"h-10 w-10 items-center justify-center rounded-xl",
					isDanger ? "bg-danger-soft" : "bg-surface-tertiary",
				)}
			>
				<Icon
					size={iconSize.bar}
					className={isDanger ? "text-danger" : "text-foreground"}
				/>
			</View>
			<Text
				className={cn(
					"font-medium text-base",
					isDanger ? "text-danger" : "text-foreground",
				)}
			>
				{label}
			</Text>
		</PressableFeedback>
	);
}

export function AccountSwitcher() {
	const router = useRouter();
	const { toast } = useToast();
	const { m } = useI18n();
	const queryClient = useQueryClient();
	const { allAccounts, activeAccount, activeAccountConfig, switchAccount } =
		useAccount();
	const [switching, setSwitching] = useState(false);
	const [isOpen, setIsOpen] = useState(false);

	const handleAccountSwitch = async (account: AccountMetadata) => {
		if (activeAccountConfig && account.accountId === activeAccountConfig) {
			setIsOpen(false);
			return;
		}

		setSwitching(true);
		try {
			// Clear query cache before switching
			queryClient.clear();

			// Switch account
			await switchAccount(account.accountId);

			// Check if the new account has a valid session
			const isValid = await storage.isSessionValid(account.accountId);

			setIsOpen(false);

			if (isValid) {
				// Has valid session, refresh the current view
				router.replace("/(tabs)");
			} else {
				// No valid session, go to unlock
				router.replace("/(auth)/unlock");
			}
		} catch (error) {
			console.error("Error switching account:", error);
			toast.show({
				variant: "danger",
				label: m.mob_account_switcher_toast_switch_failed(),
				placement: "bottom",
			});
		} finally {
			setSwitching(false);
		}
	};

	const handleAddAccount = () => {
		setIsOpen(false);
		router.push("/(auth)/login");
	};

	const handleSettings = () => {
		setIsOpen(false);
		router.push("/settings");
	};

	const handleTrash = () => {
		setIsOpen(false);
		router.push("/(tabs)/trash");
	};

	const handleLockVault = async () => {
		Alert.alert(
			m.mob_account_switcher_lock_dialog_title(),
			m.mob_account_switcher_lock_dialog_message(),
			[
				{ text: m.mob_account_switcher_lock_dialog_cancel(), style: "cancel" },
				{
					text: m.mob_account_switcher_lock_dialog_confirm(),
					style: "destructive",
					onPress: async () => {
						// Lock, not sign out: every in-memory master unlock key is dropped —
						// the native autofill mirror first — but `session_data` stays, so
						// quick-unlock still works.
						await lockAllAccounts(lifecycleDeps);

						setIsOpen(false);
						router.replace("/(auth)/unlock");
					},
				},
			],
		);
	};

	const accountFallback = m.mob_settings_account_fallback();

	return (
		<BottomSheet isOpen={isOpen} onOpenChange={setIsOpen}>
			<BottomSheet.Trigger>
				<View
					accessibilityRole="button"
					accessibilityLabel={m.mob_account_switcher_title()}
				>
					<AccountAvatar account={activeAccount} size={32} radius={10} />
				</View>
			</BottomSheet.Trigger>
			<BottomSheet.Portal>
				<BottomSheet.Overlay />
				<BottomSheet.Content>
					<SheetBrandAccent />
					<View className="items-center pt-1 pb-4">
						<BottomSheet.Title>
							{m.mob_account_switcher_title()}
						</BottomSheet.Title>
					</View>

					<View className="px-4 pb-2">
						<SectionLabel>{m.mob_settings_section_account()}</SectionLabel>
						<View className="gap-1">
							{allAccounts.map((account) => {
								const isActive = account.accountId === activeAccountConfig;
								return (
									<PressableFeedback
										key={account.accountId}
										onPress={() => handleAccountSwitch(account)}
										isDisabled={switching}
										accessibilityRole="button"
										className={cn(
											"h-16 flex-row items-center gap-3 rounded-xl px-2",
											isActive ? "border border-accent/15 bg-selected" : "",
										)}
									>
										<PressableFeedback.Highlight />
										{isActive ? <GlowBar /> : null}
										<AccountAvatar account={account} />
										<View className="min-w-0 flex-1">
											<Text
												numberOfLines={1}
												className="font-medium text-base text-foreground"
											>
												{getAccountLabel(account, accountFallback)}
											</Text>
											<Text numberOfLines={1} className="text-muted text-sm">
												{account.email}
											</Text>
										</View>
										{isActive ? (
											<IconCheck size={iconSize.row} className="text-accent" />
										) : null}
									</PressableFeedback>
								);
							})}
						</View>
					</View>

					<View className="h-px bg-separator" />

					<View className="px-4 pt-2 pb-6">
						<SheetAction
							label={m.mob_account_switcher_add_account()}
							icon={IconPlus}
							onPress={handleAddAccount}
						/>
						<SheetAction
							label={m.mob_account_switcher_settings()}
							icon={IconSettings}
							onPress={handleSettings}
						/>
						<SheetAction
							label={m.mob_account_switcher_trash()}
							icon={IconTrash}
							onPress={handleTrash}
						/>
						<SheetAction
							label={m.mob_account_switcher_lock_vault()}
							icon={IconLock}
							onPress={handleLockVault}
							tone="danger"
						/>
					</View>
				</BottomSheet.Content>
			</BottomSheet.Portal>
		</BottomSheet>
	);
}
