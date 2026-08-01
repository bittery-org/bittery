import { useCoreContext } from "@bittery/core/hooks";
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
	toast,
} from "@bittery/ui";
import { IconLoaderCircle } from "@bittery/ui/icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SettingsField } from "@/components/settings/settings-field";
import { itemCache, storage } from "@/lib/storage";
import { clearDesktopSyncState } from "@/lib/sync-client-id";
import { useI18n } from "@/providers/i18n-provider";
import { useSyncContext } from "@/providers/sync-provider";

interface SettingsAdvancedPanelProps {
	disabled?: boolean;
}

export function SettingsAdvancedPanel({
	disabled,
}: SettingsAdvancedPanelProps) {
	const { m } = useI18n();
	const core = useCoreContext();
	const syncContext = useSyncContext();
	const queryClient = useQueryClient();
	const [isClearCacheConfirmOpen, setIsClearCacheConfirmOpen] = useState(false);

	const clearCacheMutation = useMutation({
		mutationFn: async () => {
			const wasConnected = syncContext.isConnected;
			syncContext.disconnect();
			syncContext.outboundQueue.clear();

			try {
				// Always an explicit accountId: omitting it routes the cache to the literal
				// `"default"` collection, which is only ever right on web (CONTRACT.md §12.2).
				// With no accounts there is nothing cached, so there is nothing to clear.
				const accounts = await storage.getAccountsList();
				await Promise.all(
					accounts.map((account) =>
						itemCache.clearItemCache(account.accountId),
					),
				);

				await clearDesktopSyncState({ preserveClientId: true });

				core.vaultCoordinator.clear();
				queryClient.clear();

				const { accountsInfo } = await core.accounts.resolveAccounts();
				if (accountsInfo.length > 0) {
					await core.vaultCoordinator.hydrate(accountsInfo);
				}
			} finally {
				if (wasConnected) {
					void syncContext.reconnect();
				}
			}
		},
		onSuccess: () => {
			toast.success(m.settings_dialog_toast_cache_cleared());
			setIsClearCacheConfirmOpen(false);
		},
		onError: (error) => {
			console.error("Failed to clear local cache:", error);
			toast.error(m.settings_dialog_toast_cache_clear_failed());
		},
	});

	const isBusy = disabled || clearCacheMutation.isPending;

	return (
		<>
			<div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-4">
				<SettingsField
					label={m.settings_dialog_local_cache_title()}
					description={m.settings_dialog_local_cache_description()}
				>
					<Button
						variant="destructive"
						size="sm"
						onClick={() => setIsClearCacheConfirmOpen(true)}
						disabled={isBusy}
					>
						{m.settings_dialog_local_cache_action_clear()}
					</Button>
				</SettingsField>
			</div>

			<AlertDialog
				open={isClearCacheConfirmOpen}
				onOpenChange={setIsClearCacheConfirmOpen}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{m.settings_dialog_clear_cache_confirm_title()}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{m.settings_dialog_clear_cache_confirm_description()}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={clearCacheMutation.isPending}>
							{m.settings_common_action_cancel()}
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => clearCacheMutation.mutate()}
							disabled={clearCacheMutation.isPending}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							{clearCacheMutation.isPending ? (
								<>
									<IconLoaderCircle className="h-4 w-4 animate-spin" />
									{m.settings_dialog_clear_cache_confirm_action_clearing()}
								</>
							) : (
								m.settings_dialog_clear_cache_confirm_action_confirm()
							)}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
