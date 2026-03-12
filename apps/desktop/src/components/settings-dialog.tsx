import { useCoreContext } from "@bittery/core/hooks";
import { type AppLocale, supportedLocales } from "@bittery/i18n";
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
import {
	IconFlagGermany,
	IconFlagUnitedStates,
	IconLoader2OutlineDuo18,
} from "@bittery/ui/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { storage } from "@/lib/storage";
import { clearDesktopSyncState } from "@/lib/sync-client-id";
import { useI18n } from "@/providers/i18n-provider";
import { useSyncContext } from "@/providers/sync-provider";

const AUTO_LOCK_OPTION_VALUES = [
	"60000",
	"300000",
	"600000",
	"900000",
	"1800000",
	"3600000",
	"-1",
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const MASTER_PASSWORD_REENTRY_VALUES = [
	String(14 * DAY_MS),
	String(30 * DAY_MS),
	String(60 * DAY_MS),
	String(90 * DAY_MS),
] as const;

interface SettingsDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
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

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{open ? (
				settingsQuery.isLoading ? (
					<DialogContent className="sm:max-w-md">
						<div className="flex items-center justify-center py-8">
							<IconLoader2OutlineDuo18 className="h-6 w-6 animate-spin text-muted-foreground" />
						</div>
					</DialogContent>
				) : settingsQuery.data ? (
					<SettingsDialogContent
						key={`${settingsQuery.data.autoLockTimeoutMs}:${settingsQuery.data.masterPasswordReentryMs}`}
						onOpenChange={onOpenChange}
						initialAutoLockTimeout={String(
							settingsQuery.data.autoLockTimeoutMs,
						)}
						initialMasterPasswordReentry={String(
							settingsQuery.data.masterPasswordReentryMs,
						)}
					/>
				) : null
			) : null}
		</Dialog>
	);
}

function SettingsDialogContent({
	onOpenChange,
	initialAutoLockTimeout,
	initialMasterPasswordReentry,
}: Pick<SettingsDialogProps, "onOpenChange"> & {
	initialAutoLockTimeout: string;
	initialMasterPasswordReentry: string;
}) {
	const { locale, setLocale, m } = useI18n();
	const core = useCoreContext();
	const syncContext = useSyncContext();
	const queryClient = useQueryClient();
	const [autoLockTimeout, setAutoLockTimeout] = useState(
		initialAutoLockTimeout,
	);
	const [masterPasswordReentry, setMasterPasswordReentry] = useState(
		initialMasterPasswordReentry,
	);
	const [isClearCacheConfirmOpen, setIsClearCacheConfirmOpen] = useState(false);

	const autoLockOptions = useMemo(() => {
		return AUTO_LOCK_OPTION_VALUES.map((value) => {
			if (value === "-1") {
				return { value, label: m["settings.auto_lock.option.never"]() };
			}

			const ms = Number.parseInt(value, 10);
			const minutes = Math.round(ms / 60000);
			if (minutes >= 60) {
				const hours = Math.round(minutes / 60);
				return {
					value,
					label:
						hours === 1
							? m["settings.auto_lock.option.hours.single"]({ count: hours })
							: m["settings.auto_lock.option.hours.plural"]({ count: hours }),
				};
			}

			return {
				value,
				label:
					minutes === 1
						? m["settings.auto_lock.option.minutes.single"]({ count: minutes })
						: m["settings.auto_lock.option.minutes.plural"]({ count: minutes }),
			};
		});
	}, [m]);

	const masterPasswordReentryOptions = useMemo(() => {
		return MASTER_PASSWORD_REENTRY_VALUES.map((value) => {
			const days = Math.round(Number.parseInt(value, 10) / DAY_MS);
			return {
				value,
				label:
					days === 1
						? m["settings.dialog.master_password_reentry.option.days.single"]({
								count: days,
							})
						: m["settings.dialog.master_password_reentry.option.days.plural"]({
								count: days,
							}),
			};
		});
	}, [m]);

	const activeLocaleLabel =
		locale === "en" ? m["i18n.language.en"]() : m["i18n.language.de"]();
	const ActiveLocaleFlag =
		locale === "en" ? IconFlagUnitedStates : IconFlagGermany;
	const isDirty =
		autoLockTimeout !== initialAutoLockTimeout ||
		masterPasswordReentry !== initialMasterPasswordReentry;

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
			toast.success(m["settings.dialog.toast.saved"]());
			queryClient.invalidateQueries({ queryKey: ["desktopSettings"] });
			queryClient.invalidateQueries({ queryKey: ["sessionState"] });
			onOpenChange(false);
		},
		onError: (error) => {
			console.error("Failed to save desktop settings:", error);
			toast.error(m["settings.dialog.toast.save_failed"]());
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
				await core.vaultCoordinator.hydrate(accountsInfo);
			}

			if (wasConnected) {
				void syncContext.reconnect();
			}
		},
		onSuccess: () => {
			toast.success(m["settings.dialog.toast.cache_cleared"]());
			setIsClearCacheConfirmOpen(false);
		},
		onError: (error) => {
			console.error("Failed to clear local cache:", error);
			toast.error(m["settings.dialog.toast.cache_clear_failed"]());
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
		onOpenChange(false);
	};

	const isBusy = saveMutation.isPending || clearCacheMutation.isPending;

	return (
		<>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{m["settings.page.title"]()}</DialogTitle>
					<DialogDescription>
						{m["settings.dialog.description"]()}
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="language">
							{m["settings.general.language.title"]()}
						</Label>
						<Select
							value={locale}
							onValueChange={(value) => setLocale(value as AppLocale)}
						>
							<SelectTrigger id="language">
								<div className="flex items-center gap-2">
									<ActiveLocaleFlag size={14} className="shrink-0" />
									<SelectValue
										placeholder={m["settings.general.language.title"]()}
									>
										{activeLocaleLabel}
									</SelectValue>
								</div>
							</SelectTrigger>
							<SelectContent>
								{supportedLocales.map((value) => (
									<SelectItem key={value} value={value}>
										<span className="inline-flex items-center gap-2 whitespace-nowrap">
											{value === "en" ? (
												<IconFlagUnitedStates size={14} className="shrink-0" />
											) : (
												<IconFlagGermany size={14} className="shrink-0" />
											)}
											<span>
												{value === "en"
													? m["i18n.language.en"]()
													: m["i18n.language.de"]()}
											</span>
										</span>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<p className="text-muted-foreground text-xs">
							{m["settings.general.language.description"]()}
						</p>
					</div>

					<div className="space-y-2">
						<Label htmlFor="autoLockTimeout">
							{m["settings.security.auto_lock"]()}
						</Label>
						<Select value={autoLockTimeout} onValueChange={setAutoLockTimeout}>
							<SelectTrigger id="autoLockTimeout">
								<SelectValue placeholder={m["settings.security.auto_lock"]()} />
							</SelectTrigger>
							<SelectContent>
								{autoLockOptions.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<p className="text-muted-foreground text-xs">
							{m["settings.security.auto_lock_description"]()}
						</p>
					</div>

					<div className="space-y-2">
						<Label htmlFor="masterPasswordReentry">
							{m["settings.dialog.master_password_reentry.label"]()}
						</Label>
						<Select
							value={masterPasswordReentry}
							onValueChange={setMasterPasswordReentry}
						>
							<SelectTrigger id="masterPasswordReentry">
								<SelectValue
									placeholder={m[
										"settings.dialog.master_password_reentry.placeholder"
									]()}
								/>
							</SelectTrigger>
							<SelectContent>
								{masterPasswordReentryOptions.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<p className="text-muted-foreground text-xs">
							{m["settings.dialog.master_password_reentry.description"]()}
						</p>
					</div>

					<div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
						<Label>{m["settings.dialog.local_cache.title"]()}</Label>
						<p className="text-muted-foreground text-xs">
							{m["settings.dialog.local_cache.description"]()}
						</p>
						<Button
							variant="destructive"
							size="sm"
							onClick={() => setIsClearCacheConfirmOpen(true)}
							disabled={isBusy}
						>
							{m["settings.dialog.local_cache.action.clear"]()}
						</Button>
					</div>
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={handleClose} disabled={isBusy}>
						{m["settings.common.action.cancel"]()}
					</Button>
					<Button onClick={handleSave} disabled={isBusy || !isDirty}>
						{saveMutation.isPending ? (
							<>
								<IconLoader2OutlineDuo18 className="h-4 w-4 animate-spin" />
								{m["settings.common.action.saving"]()}
							</>
						) : (
							m["settings.dialog.action.save"]()
						)}
					</Button>
				</DialogFooter>
			</DialogContent>

			<AlertDialog
				open={isClearCacheConfirmOpen}
				onOpenChange={setIsClearCacheConfirmOpen}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{m["settings.dialog.clear_cache.confirm.title"]()}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{m["settings.dialog.clear_cache.confirm.description"]()}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={clearCacheMutation.isPending}>
							{m["settings.common.action.cancel"]()}
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => clearCacheMutation.mutate()}
							disabled={clearCacheMutation.isPending}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							{clearCacheMutation.isPending ? (
								<>
									<IconLoader2OutlineDuo18 className="h-4 w-4 animate-spin" />
									{m["settings.dialog.clear_cache.confirm.action.clearing"]()}
								</>
							) : (
								m["settings.dialog.clear_cache.confirm.action.confirm"]()
							)}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
