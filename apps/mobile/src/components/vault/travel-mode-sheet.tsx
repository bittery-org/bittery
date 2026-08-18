/**
 * Travel mode for one account: pick the vaults to hide, turn it on, and turn it off again with
 * the master password.
 *
 * Mobile has enforced travel mode since the Expo app (`getTravelModeEnforcer` runs on unlock)
 * but has never had a way to *configure* it — that UI was desktop-only
 * (`apps/desktop/src/components/travel-mode-settings.tsx`). This is that panel as a sheet, over
 * the same `useTravelMode` hook, one account at a time because the settings screen renders one
 * row per account rather than stacking N panels the way desktop's does.
 *
 * The vault list comes from the server rather than `useAllVaultKeys`, and that is the whole
 * point of the feature: enabling travel mode *deletes the hidden vaults locally*, so a local
 * list would show an ever-shrinking set and there would be no way to see what is hidden or to
 * change the selection afterwards.
 */

import { useTravelMode } from "@bittery/core/hooks";
import { createStoredAccountApiClient } from "@bittery/core/services/api-client";
import { Skeleton, toast } from "@bittery/ui";
import { IconCheck, IconPlane, IconTriangleAlert } from "@bittery/ui/icons";
import { cn } from "@bittery/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { InlineNotice } from "@/components/auth-kit";
import {
	BrandButton,
	IconTile,
	iconClass,
	ListCard,
	ListRow,
	MobileSheet,
	Pressable,
	SectionLabel,
	TextField,
} from "@/components/ui";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

interface TravelModeSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	accountId: string;
	/** Shown under the title when the device holds more than one account. */
	accountLabel?: string;
}

export function TravelModeSheet({
	open,
	onOpenChange,
	accountId,
	accountLabel,
}: TravelModeSheetProps) {
	const { m } = useI18n();

	const [draftVaultIds, setDraftVaultIds] = useState<string[] | null>(null);
	const [isDisabling, setIsDisabling] = useState(false);
	const [disablePassword, setDisablePassword] = useState("");

	const {
		isEnabled,
		isLoading,
		hiddenVaultIds,
		setHiddenVaults,
		enable,
		disable,
	} = useTravelMode(accountId);

	const vaultsQuery = useQuery({
		queryKey: ["travel-mode-vault-picker", accountId],
		enabled: open,
		queryFn: async () => {
			// A client for *this* account, not the app-level `useApiClient` — that one is bound
			// to whichever account is active, so on a two-account device the second row would
			// otherwise list the first account's vaults and offer to hide the wrong ones.
			const client = await createStoredAccountApiClient(storage, accountId);
			if (!client) throw new Error("Account session is not available");
			const { data } = await client.vaults.list();
			return data.map((vault) => ({
				vaultId: vault.id,
				vaultName: vault.name,
			}));
		},
	});
	const vaults = vaultsQuery.data ?? [];

	/** The saved selection until the user touches a row, then the unsaved one. */
	const selection = draftVaultIds ?? hiddenVaultIds;
	const isBusy =
		setHiddenVaults.isPending || enable.isPending || disable.isPending;

	const toggleVault = (vaultId: string) => {
		setDraftVaultIds((current) => {
			const base = current ?? [...hiddenVaultIds];
			return base.includes(vaultId)
				? base.filter((id) => id !== vaultId)
				: [...base, vaultId];
		});
	};

	const handleSaveSelection = async () => {
		try {
			await setHiddenVaults.mutateAsync(selection);
			setDraftVaultIds(null);
			toast.success(m.travel_mode_toast_selection_saved());
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: m.travel_mode_toast_selection_save_failed(),
			);
		}
	};

	const handleEnable = async () => {
		try {
			await enable.mutateAsync(selection);
			setDraftVaultIds(null);
			toast.success(m.travel_mode_toast_enabled());
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: m.travel_mode_toast_enable_failed(),
			);
		}
	};

	const handleDisable = async () => {
		try {
			await disable.mutateAsync({ password: disablePassword });
			toast.success(m.travel_mode_toast_disabled());
			setIsDisabling(false);
			setDisablePassword("");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: m.travel_mode_toast_disable_failed(),
			);
		}
	};

	// Disabling is a second, password-gated step, so it takes over the sheet rather than
	// appearing as a field under a list the user can no longer act on.
	if (isDisabling) {
		return (
			<MobileSheet
				open={open}
				onOpenChange={(next) => {
					if (disable.isPending) return;
					if (!next) {
						setIsDisabling(false);
						setDisablePassword("");
					}
				}}
				title={m.travel_mode_disable_title()}
				description={m.travel_mode_disable_description()}
			>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void handleDisable();
					}}
					className="flex flex-col gap-3 px-4 pt-1 pb-6"
				>
					<TextField
						label={m.travel_mode_disable_password_label()}
						type="password"
						value={disablePassword}
						onChange={(event) => setDisablePassword(event.target.value)}
						disabled={disable.isPending}
						autoFocus
					/>
					<BrandButton
						label={
							disable.isPending
								? m.travel_mode_action_disabling()
								: m.travel_mode_action_disable()
						}
						isLoading={disable.isPending}
						disabled={!disablePassword}
						onClick={() => void handleDisable()}
					/>
					<Pressable
						onClick={() => {
							setIsDisabling(false);
							setDisablePassword("");
						}}
						disabled={disable.isPending}
						surface="sheet"
						className="flex h-11 w-full items-center justify-center rounded-xl bg-surface-tertiary font-medium text-base text-foreground"
					>
						{m.team_common_action_cancel()}
					</Pressable>
				</form>
			</MobileSheet>
		);
	}

	return (
		<MobileSheet
			open={open}
			onOpenChange={(next) => {
				if (isBusy) return;
				onOpenChange(next);
			}}
			title={m.travel_mode_title()}
			description={accountLabel ?? m.travel_mode_description()}
		>
			<div className="flex flex-col gap-4 px-4 pt-1 pb-6">
				{accountLabel ? (
					<p className="text-muted-foreground text-sm">
						{m.travel_mode_description()}
					</p>
				) : null}

				{isEnabled ? (
					<InlineNotice
						tone="warning"
						icon={IconPlane}
						description={m.travel_mode_active_banner({
							count: String(hiddenVaultIds.length),
						})}
					/>
				) : null}

				<section>
					<SectionLabel>{m.travel_mode_vault_picker_label()}</SectionLabel>
					{isLoading || vaultsQuery.isLoading ? (
						<div className="flex flex-col gap-2">
							{[0, 1, 2].map((row) => (
								<Skeleton key={row} className="h-14 rounded-2xl" />
							))}
						</div>
					) : vaults.length === 0 ? (
						<p className="px-1 text-muted-foreground text-sm">
							{isEnabled
								? m.travel_mode_empty_all_hidden()
								: m.travel_mode_no_vaults()}
						</p>
					) : (
						<ListCard>
							{vaults.map((vault) => {
								const isHidden = selection.includes(vault.vaultId);
								return (
									<ListRow
										key={vault.vaultId}
										title={vault.vaultName}
										isSelected={isHidden}
										// The selection is frozen while travel mode is on: changing
										// which vaults are hidden means re-deriving what is stored
										// locally, which needs the master password.
										isDisabled={isEnabled || isBusy}
										onPress={() => toggleVault(vault.vaultId)}
										trailing={
											isHidden ? (
												<IconCheck
													className={cn(iconClass.row, "text-primary")}
												/>
											) : undefined
										}
									/>
								);
							})}
						</ListCard>
					)}
				</section>

				{isEnabled ? (
					<Pressable
						onClick={() => setIsDisabling(true)}
						scale
						haptic={false}
						className="flex h-12 w-full items-center justify-center rounded-xl bg-danger font-semibold text-base text-white"
					>
						{m.travel_mode_action_disable()}
					</Pressable>
				) : (
					<div className="flex flex-col gap-2">
						<InlineNotice
							tone="warning"
							icon={IconTriangleAlert}
							description={m.travel_mode_description()}
						/>
						<BrandButton
							label={m.travel_mode_action_enable()}
							isLoading={enable.isPending}
							disabled={selection.length === 0 || isBusy}
							onClick={() => void handleEnable()}
						/>
						<Pressable
							onClick={() => void handleSaveSelection()}
							disabled={isBusy}
							surface="sheet"
							className="flex h-11 w-full items-center justify-center rounded-xl bg-surface-tertiary font-medium text-base text-foreground"
						>
							{m.travel_mode_action_save_selection()}
						</Pressable>
					</div>
				)}
			</div>
		</MobileSheet>
	);
}

/**
 * The settings-screen door to the sheet above, and the row that reports whether travel mode is
 * on for this account. One per account, because travel mode is a server-side per-account flag
 * — unlike the biometric and auto-lock switches on the same screen, which are device-wide and
 * fan out over every account at their call site.
 */
export function TravelModeRow({
	accountId,
	accountLabel,
	showAccountLabel,
}: {
	accountId: string;
	accountLabel: string;
	/** Puts the account under the title, for devices holding more than one. */
	showAccountLabel: boolean;
}) {
	const { m } = useI18n();
	const [isOpen, setIsOpen] = useState(false);
	const { isEnabled, hiddenVaultIds } = useTravelMode(accountId);

	return (
		<>
			<ListRow
				title={m.travel_mode_title()}
				subtitle={
					showAccountLabel
						? accountLabel
						: isEnabled
							? m.mob_travel_mode_hidden_count({
									count: String(hiddenVaultIds.length),
								})
							: m.mob_settings_disabled()
				}
				value={
					showAccountLabel
						? isEnabled
							? m.mob_travel_mode_hidden_count({
									count: String(hiddenVaultIds.length),
								})
							: m.mob_settings_disabled()
						: undefined
				}
				leading={
					<IconTile tone={isEnabled ? "brand" : "default"}>
						<IconPlane className={iconClass.row} />
					</IconTile>
				}
				onPress={() => setIsOpen(true)}
				showChevron
			/>
			<TravelModeSheet
				open={isOpen}
				onOpenChange={setIsOpen}
				accountId={accountId}
				accountLabel={showAccountLabel ? accountLabel : undefined}
			/>
		</>
	);
}
