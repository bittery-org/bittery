import { useCoreContext } from "@bittery/core/hooks";
import { Button, ConfirmDialog, toast } from "@bittery/ui";
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
				// `clearItemCache` requires an accountId per account, so each is cleared
				// individually; with no accounts there is nothing cached to clear.
				const accounts = await storage.getAccountsList();
				await Promise.all(
					accounts.map((account) =>
						itemCache.clearItemCache(account.accountId),
					),
				);

				await clearDesktopSyncState({ preserveClientId: true });

				core.vaultRepository.clear();
				queryClient.clear();

				await core.vaultRuntime.retry();
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

			<ConfirmDialog
				open={isClearCacheConfirmOpen}
				onOpenChange={setIsClearCacheConfirmOpen}
				title={m.settings_dialog_clear_cache_confirm_title()}
				description={m.settings_dialog_clear_cache_confirm_description()}
				cancelLabel={m.settings_common_action_cancel()}
				confirmLabel={
					clearCacheMutation.isPending ? (
						<>
							<IconLoaderCircle className="h-4 w-4 animate-spin" />
							{m.settings_dialog_clear_cache_confirm_action_clearing()}
						</>
					) : (
						m.settings_dialog_clear_cache_confirm_action_confirm()
					)
				}
				onConfirm={() => clearCacheMutation.mutate()}
				busy={clearCacheMutation.isPending}
				destructive
			/>
		</>
	);
}
