/**
 * The account avatar in the app bar, and the sheet behind it. Ported from
 * `apps/mobile/src/components/account-switcher.tsx`, which is the design this app was
 * missing entirely: switching accounts, settings, trash and lock all lived as loose header
 * buttons here, or nowhere.
 *
 * Lock is not sign-out: every in-memory master unlock key is dropped — the native autofill
 * mirror first — but `session_data` stays, so quick-unlock still works afterwards.
 */

import { toast } from "@bittery/ui";
import {
	IconCheck,
	IconLock,
	IconPlus,
	IconSettings,
	IconTrash,
} from "@bittery/ui/icons";
import { cn } from "@bittery/ui/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
	AccountAvatar,
	ConfirmSheet,
	getAccountLabel,
	MobileSheet,
	Pressable,
	SectionLabel,
	SheetAction,
} from "@/components/ui";
import { useAccount } from "@/contexts/account-context";
import { type AccountMetadata, storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

export function AccountSwitcher() {
	const navigate = useNavigate();
	const { m } = useI18n();
	const queryClient = useQueryClient();
	const { allAccounts, activeAccount, switchAccount, lockAllAccounts } =
		useAccount();
	const [isOpen, setIsOpen] = useState(false);
	const [isSwitching, setIsSwitching] = useState(false);
	const [isConfirmingLock, setIsConfirmingLock] = useState(false);

	const activeAccountId = activeAccount?.accountId ?? null;
	const accountFallback = m.mob_settings_account_fallback();

	const handleAccountSwitch = async (account: AccountMetadata) => {
		if (account.accountId === activeAccountId) {
			setIsOpen(false);
			return;
		}

		setIsSwitching(true);
		try {
			// The cache is keyed by nothing account-scoped, so it has to go before the
			// switch — otherwise the new account briefly renders the old one's items.
			queryClient.clear();
			await switchAccount(account.accountId);

			const hasValidSession = await storage.isSessionValid(account.accountId);
			setIsOpen(false);
			await navigate({ to: hasValidSession ? "/vault" : "/unlock" });
		} catch (error) {
			console.error("[AccountSwitcher] switch failed", error);
			toast.error(m.mob_account_switcher_toast_switch_failed());
		} finally {
			setIsSwitching(false);
		}
	};

	const go = (to: "/login" | "/vault/settings" | "/vault/trash") => {
		setIsOpen(false);
		void navigate({ to });
	};

	const handleLock = async () => {
		await lockAllAccounts();
		setIsConfirmingLock(false);
		setIsOpen(false);
		await navigate({ to: "/unlock" });
	};

	return (
		<>
			<Pressable
				onClick={() => setIsOpen(true)}
				aria-label={m.mob_account_switcher_title()}
				scale
				haptic={false}
				className="shrink-0 rounded-[10px]"
			>
				<AccountAvatar account={activeAccount} size={32} radius={10} />
			</Pressable>

			<MobileSheet
				open={isOpen}
				onOpenChange={setIsOpen}
				title={m.mob_account_switcher_title()}
			>
				<div className="px-4 pb-2">
					<SectionLabel>{m.mob_settings_section_account()}</SectionLabel>
					<div className="flex flex-col gap-1">
						{allAccounts.map((account) => {
							const isActive = account.accountId === activeAccountId;
							return (
								<Pressable
									key={account.accountId}
									onClick={() => void handleAccountSwitch(account)}
									disabled={isSwitching}
									surface="sheet"
									className={cn(
										"flex h-16 w-full items-center gap-3 rounded-xl px-2",
										isActive && "border border-primary/15 bg-selected",
									)}
								>
									<AccountAvatar account={account} />
									<span className="min-w-0 flex-1 text-left">
										<span className="block truncate font-medium text-base text-foreground">
											{getAccountLabel(account, accountFallback)}
										</span>
										<span className="block truncate text-muted-foreground text-sm">
											{account.email}
										</span>
									</span>
									{isActive ? (
										<IconCheck className="size-[18px] shrink-0 text-primary" />
									) : null}
								</Pressable>
							);
						})}
					</div>
				</div>

				<div className="mt-2 h-px bg-separator" />

				<div className="flex flex-col px-4 pt-2 pb-6">
					<SheetAction
						label={m.mob_account_switcher_add_account()}
						icon={IconPlus}
						onPress={() => go("/login")}
					/>
					<SheetAction
						label={m.mob_account_switcher_settings()}
						icon={IconSettings}
						onPress={() => go("/vault/settings")}
					/>
					<SheetAction
						label={m.mob_account_switcher_trash()}
						icon={IconTrash}
						onPress={() => go("/vault/trash")}
					/>
					<SheetAction
						label={m.mob_account_switcher_lock_vault()}
						icon={IconLock}
						onPress={() => setIsConfirmingLock(true)}
						tone="danger"
					/>
				</div>
			</MobileSheet>

			<ConfirmSheet
				open={isConfirmingLock}
				onOpenChange={setIsConfirmingLock}
				title={m.mob_account_switcher_lock_dialog_title()}
				description={m.mob_account_switcher_lock_dialog_message()}
				confirmLabel={m.mob_account_switcher_lock_dialog_confirm()}
				cancelLabel={m.mob_account_switcher_lock_dialog_cancel()}
				onConfirm={() => void handleLock()}
			/>
		</>
	);
}
