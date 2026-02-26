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
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Label,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	toast,
} from "@bittery/ui";
import { IconLoader2OutlineDuo18 } from "@bittery/ui/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { DEFAULT_AUTO_LOCK_TIMEOUT_MS, storage } from "@/lib/storage";
import { clearDesktopSyncState } from "@/lib/sync-client-id";
import { useSyncContext } from "@/providers/sync-provider";

// Auto-lock timeout options (in milliseconds)
// -1 means never auto-lock
const AUTO_LOCK_OPTIONS = [
	{ value: "60000", label: "1 minute" },
	{ value: "300000", label: "5 minutes" },
	{ value: "600000", label: "10 minutes" },
	{ value: "900000", label: "15 minutes" },
	{ value: "1800000", label: "30 minutes" },
	{ value: "3600000", label: "1 hour" },
	{ value: "-1", label: "Never" },
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const MASTER_PASSWORD_REENTRY_OPTIONS = [
	{ value: String(14 * DAY_MS), label: "14 days" },
	{ value: String(30 * DAY_MS), label: "30 days" },
	{ value: String(60 * DAY_MS), label: "60 days" },
	{ value: String(90 * DAY_MS), label: "90 days" },
] as const;

interface SettingsDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
	const core = useCoreContext();
	const syncContext = useSyncContext();
	const queryClient = useQueryClient();
	const [autoLockTimeout, setAutoLockTimeout] = useState(
		String(DEFAULT_AUTO_LOCK_TIMEOUT_MS),
	);
	const [masterPasswordReentry, setMasterPasswordReentry] = useState(
		String(30 * DAY_MS),
	);
	const [isDirty, setIsDirty] = useState(false);
	const [isClearCacheConfirmOpen, setIsClearCacheConfirmOpen] = useState(false);

	const settingsQuery = useQuery({
		queryKey: ["desktopSettings"],
		queryFn: async () => {
			const [autoLockTimeoutMs, masterPasswordReentryMs] = await Promise.all([
				storage.getAutoLockTimeoutOrDefault(),
				storage.getMasterPasswordReentryPeriodMs(),
			]);
			return { autoLockTimeoutMs, masterPasswordReentryMs };
		},
		enabled: open,
	});

	useEffect(() => {
		if (open) {
			if (settingsQuery.data !== undefined) {
				setAutoLockTimeout(String(settingsQuery.data.autoLockTimeoutMs));
				setMasterPasswordReentry(
					String(settingsQuery.data.masterPasswordReentryMs),
				);
			}
			setIsDirty(false);
		}
	}, [open, settingsQuery.data]);

	const saveMutation = useMutation({
		mutationFn: async ({
			timeout,
			reentryPeriod,
		}: {
			timeout: string;
			reentryPeriod: string;
		}) => {
			const timeoutMs = Number.parseInt(timeout, 10);
			const reentryPeriodMs = Number.parseInt(reentryPeriod, 10);
			await Promise.all([
				storage.storeAutoLockTimeout(timeoutMs),
				storage.storeMasterPasswordReentryPeriodMs(reentryPeriodMs),
			]);
		},
		onSuccess: () => {
			toast.success("Settings saved successfully");
			queryClient.invalidateQueries({ queryKey: ["desktopSettings"] });
			queryClient.invalidateQueries({ queryKey: ["sessionState"] });
			setIsDirty(false);
			onOpenChange(false);
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	const clearCacheMutation = useMutation({
		mutationFn: async () => {
			const wasConnected = syncContext.isConnected;
			syncContext.disconnect();
			syncContext.outboundQueue.clear();

			const accounts = await storage.getAccountsList();
			if (accounts.length === 0) {
				await storage.clearItemCache();
			} else {
				await Promise.all(
					accounts.map((account) => storage.clearItemCache(account.email)),
				);
			}

			await clearDesktopSyncState({ preserveClientId: true });

			core.vaultCoordinator.clear();
			queryClient.clear();

			const { accountsInfo } = await core.accounts.resolveAccounts();
			if (accountsInfo.length > 0) {
				await core.vaultCoordinator.refreshFromServer(accountsInfo);
			}

			if (wasConnected) {
				void syncContext.reconnect();
			}
		},
		onSuccess: () => {
			toast.success("Local cache and sync state cleared");
			setIsClearCacheConfirmOpen(false);
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to clear local cache");
		},
	});

	const handleSave = () => {
		saveMutation.mutate({
			timeout: autoLockTimeout,
			reentryPeriod: masterPasswordReentry,
		});
	};

	const handleClose = () => {
		if (saveMutation.isPending || clearCacheMutation.isPending) {
			return;
		}
		if (isDirty) {
			setAutoLockTimeout(
				String(
					settingsQuery.data?.autoLockTimeoutMs ?? DEFAULT_AUTO_LOCK_TIMEOUT_MS,
				),
			);
			setMasterPasswordReentry(
				String(settingsQuery.data?.masterPasswordReentryMs ?? 30 * DAY_MS),
			);
			setIsDirty(false);
		}
		onOpenChange(false);
	};

	const handleAutoLockTimeoutChange = (value: string) => {
		setAutoLockTimeout(value);
		setIsDirty(true);
	};

	const handleMasterPasswordReentryChange = (value: string) => {
		setMasterPasswordReentry(value);
		setIsDirty(true);
	};

	const isLoading = settingsQuery.isLoading;
	const isBusy = saveMutation.isPending || clearCacheMutation.isPending;

	return (
		<>
			<Dialog open={open} onOpenChange={handleClose}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Settings</DialogTitle>
						<DialogDescription>Configure app settings</DialogDescription>
					</DialogHeader>

					{isLoading ? (
						<div className="flex items-center justify-center py-8">
							<IconLoader2OutlineDuo18 className="h-6 w-6 animate-spin text-muted-foreground" />
						</div>
					) : (
						<div className="space-y-4">
							<div className="space-y-2">
								<Label htmlFor="autoLockTimeout">Auto-Lock Timeout</Label>
								<Select
									value={autoLockTimeout}
									onValueChange={handleAutoLockTimeoutChange}
								>
									<SelectTrigger id="autoLockTimeout">
										<SelectValue placeholder="Select timeout" />
									</SelectTrigger>
									<SelectContent>
										{AUTO_LOCK_OPTIONS.map((option) => (
											<SelectItem key={option.value} value={option.value}>
												{option.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<p className="text-muted-foreground text-xs">
									Automatically lock your vault after a period of inactivity.
								</p>
							</div>

							<div className="space-y-2">
								<Label htmlFor="masterPasswordReentry">
									Master Password Re-entry
								</Label>
								<Select
									value={masterPasswordReentry}
									onValueChange={handleMasterPasswordReentryChange}
								>
									<SelectTrigger id="masterPasswordReentry">
										<SelectValue placeholder="Select interval" />
									</SelectTrigger>
									<SelectContent>
										{MASTER_PASSWORD_REENTRY_OPTIONS.map((option) => (
											<SelectItem key={option.value} value={option.value}>
												{option.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<p className="text-muted-foreground text-xs">
									Require the master password periodically when using biometric
									unlock.
								</p>
							</div>

							<div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
								<Label>Local Cache</Label>
								<p className="text-muted-foreground text-xs">
									Clear encrypted item cache, vault cache, pending sync queue,
									and sync cursor state on this device.
								</p>
								<Button
									variant="destructive"
									size="sm"
									onClick={() => setIsClearCacheConfirmOpen(true)}
									disabled={isBusy}
								>
									Clear Local Cache
								</Button>
							</div>
						</div>
					)}

					<DialogFooter>
						<Button variant="outline" onClick={handleClose} disabled={isBusy}>
							Cancel
						</Button>
						<Button onClick={handleSave} disabled={isBusy || !isDirty}>
							{saveMutation.isPending ? (
								<>
									<IconLoader2OutlineDuo18 className="h-4 w-4 animate-spin" />
									Saving...
								</>
							) : (
								"Save"
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<AlertDialog
				open={isClearCacheConfirmOpen}
				onOpenChange={setIsClearCacheConfirmOpen}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Clear local cache?</AlertDialogTitle>
						<AlertDialogDescription>
							This removes local item/vault cache and sync state (including last
							sync cursor) on this device. Your server data is not deleted.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={clearCacheMutation.isPending}>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => clearCacheMutation.mutate()}
							disabled={clearCacheMutation.isPending}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							{clearCacheMutation.isPending ? (
								<>
									<IconLoader2OutlineDuo18 className="h-4 w-4 animate-spin" />
									Clearing...
								</>
							) : (
								"Clear Cache"
							)}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
