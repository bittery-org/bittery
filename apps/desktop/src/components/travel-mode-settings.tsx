import { useCoreContext, useTravelMode } from "@bittery/core/hooks";
import type { AccountInfo } from "@bittery/core/services/account-resolver";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	Button,
	Checkbox,
	Input,
	Label,
	toast,
} from "@bittery/ui";
import { IconLoader2OutlineDuo18 } from "@bittery/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { SettingsSection } from "@/components/settings/settings-field";
import { useI18n } from "@/providers/i18n-provider";

interface TravelModeAccountSettingsProps {
	account: AccountInfo;
	showAccountHeading: boolean;
}

function TravelModeAccountSettings({
	account,
	showAccountHeading,
}: TravelModeAccountSettingsProps) {
	const { m } = useI18n();
	const [selectedVaultIds, setSelectedVaultIds] = useState<string[] | null>(
		null,
	);
	const [isDisableDialogOpen, setIsDisableDialogOpen] = useState(false);
	const [disablePassword, setDisablePassword] = useState("");

	const vaultListQuery = useQuery({
		queryKey: ["travel-mode-vault-picker", account.accountId],
		queryFn: async () => {
			const vaults = await account.rpcClient.vault.list.query();
			return vaults.map((vault) => ({
				vaultId: vault.id,
				vaultName: vault.name,
			}));
		},
	});
	const vaultKeys = vaultListQuery.data ?? [];
	const {
		isEnabled,
		isLoading,
		hiddenVaultIds,
		setHiddenVaults,
		enable,
		disable,
	} = useTravelMode(account.email);

	const effectiveSelection = useMemo(() => {
		return selectedVaultIds ?? hiddenVaultIds;
	}, [hiddenVaultIds, selectedVaultIds]);

	const handleDisable = async () => {
		try {
			await disable.mutateAsync({ password: disablePassword });
			toast.success(m.travel_mode_toast_disabled());
			setIsDisableDialogOpen(false);
			setDisablePassword("");
		} catch (error) {
			console.error(error);
			toast.error(m.travel_mode_toast_disable_failed());
		}
	};

	const isDisabling = disable.isPending;

	const handleToggleVault = (vaultId: string, checked: boolean) => {
		setSelectedVaultIds((current) => {
			const base = current ?? [...hiddenVaultIds];
			if (checked) {
				return base.includes(vaultId) ? base : [...base, vaultId];
			}
			return base.filter((id) => id !== vaultId);
		});
	};

	const handleSaveSelection = async () => {
		try {
			await setHiddenVaults.mutateAsync(effectiveSelection);
			toast.success(m.travel_mode_toast_selection_saved());
		} catch (error) {
			console.error(error);
			toast.error(m.travel_mode_toast_selection_save_failed());
		}
	};

	const handleEnable = async () => {
		try {
			await enable.mutateAsync(effectiveSelection);
			toast.success(m.travel_mode_toast_enabled());
		} catch (error) {
			console.error(error);
			toast.error(m.travel_mode_toast_enable_failed());
		}
	};

	return (
		<div
			className={
				showAccountHeading
					? "space-y-4 border-t pt-6 first:border-t-0 first:pt-0"
					: "space-y-4"
			}
		>
			{showAccountHeading ? (
				<div>
					<p className="font-medium text-sm">{account.name}</p>
					<p className="text-muted-foreground text-sm">{account.email}</p>
				</div>
			) : null}

			{isEnabled ? (
				<p className="font-medium text-amber-600 text-sm dark:text-amber-400">
					{m.travel_mode_active_banner({
						count: String(hiddenVaultIds.length),
					})}
				</p>
			) : null}

			{isLoading || vaultListQuery.isLoading ? (
				<p className="text-muted-foreground text-sm">
					{m.auth_invite_loading_auth()}
				</p>
			) : (
				<div className="space-y-2">
					<Label>{m.travel_mode_vault_picker_label()}</Label>
					<div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border bg-muted/20 p-4">
						{vaultKeys.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								{isEnabled
									? m.travel_mode_empty_all_hidden()
									: m.travel_mode_no_vaults()}
							</p>
						) : (
							vaultKeys.map((vault) => (
								<div
									key={vault.vaultId}
									className="flex items-center gap-2 text-sm"
								>
									<Checkbox
										checked={effectiveSelection.includes(vault.vaultId)}
										disabled={isEnabled}
										onCheckedChange={(checked) =>
											handleToggleVault(vault.vaultId, checked === true)
										}
									/>
									<span>{vault.vaultName}</span>
								</div>
							))
						)}
					</div>
				</div>
			)}

			<div className="flex flex-wrap gap-2">
				{!isEnabled ? (
					<>
						<Button
							variant="outline"
							onClick={handleSaveSelection}
							disabled={setHiddenVaults.isPending || isLoading}
						>
							{m.travel_mode_action_save_selection()}
						</Button>
						<Button
							onClick={handleEnable}
							disabled={enable.isPending || effectiveSelection.length === 0}
						>
							{m.travel_mode_action_enable()}
						</Button>
					</>
				) : (
					<Button
						variant="destructive"
						onClick={() => setIsDisableDialogOpen(true)}
					>
						{m.travel_mode_action_disable()}
					</Button>
				)}
			</div>

			<AlertDialog
				open={isDisableDialogOpen}
				onOpenChange={(next) => {
					if (isDisabling) {
						return;
					}
					setIsDisableDialogOpen(next);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{m.travel_mode_disable_title()}</AlertDialogTitle>
						<AlertDialogDescription>
							{m.travel_mode_disable_description()}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<div className="space-y-2">
						<Label
							htmlFor={`travel-mode-disable-password-${account.accountId}`}
						>
							{m.travel_mode_disable_password_label()}
						</Label>
						<Input
							id={`travel-mode-disable-password-${account.accountId}`}
							type="password"
							value={disablePassword}
							onChange={(event) => setDisablePassword(event.target.value)}
						/>
					</div>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={isDisabling}>
							{m.team_common_action_cancel()}
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={(event) => {
								event.preventDefault();
								handleDisable();
							}}
							disabled={!disablePassword || isDisabling}
						>
							{isDisabling ? (
								<>
									<IconLoader2OutlineDuo18 className="h-4 w-4 animate-spin" />
									{m.travel_mode_action_disabling()}
								</>
							) : (
								m.travel_mode_action_disable()
							)}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

export function TravelModeSettings() {
	const { m } = useI18n();
	const core = useCoreContext();
	const accountsQuery = useQuery({
		queryKey: ["travel-mode-settings-accounts"],
		queryFn: () => core.accounts.resolveAccounts(),
	});

	const accounts = accountsQuery.data?.accountsInfo ?? [];
	const isAllAccountsMode = accountsQuery.data?.isAllAccountsMode ?? false;

	if (accountsQuery.isLoading) {
		return (
			<SettingsSection
				title={m.travel_mode_title()}
				description={m.travel_mode_description()}
			>
				<p className="text-muted-foreground text-sm">
					{m.auth_invite_loading_auth()}
				</p>
			</SettingsSection>
		);
	}

	if (accounts.length === 0) {
		return null;
	}

	return (
		<SettingsSection
			title={m.travel_mode_title()}
			description={m.travel_mode_description()}
		>
			{accounts.map((account) => (
				<TravelModeAccountSettings
					key={account.accountId}
					account={account}
					showAccountHeading={isAllAccountsMode}
				/>
			))}
		</SettingsSection>
	);
}
