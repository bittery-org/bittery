import {
	Button,
	Label,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	toast,
} from "@bittery/ui";
import {
	IconArrowDoorOutOutlineDuo18,
	IconArrowLeftOutlineDuo18,
	IconClockTimeOutlineDuo18,
	IconGear3OutlineDuo18,
} from "@bittery/ui/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useI18n } from "../providers/i18n-provider";
import { DEFAULT_AUTO_LOCK_TIMEOUT_MS, storage } from "../lib/storage";

interface DesktopStatus {
	available: boolean;
	locked: boolean;
	unlockedAccounts: string[];
	timestamp: number;
	autolockTimeoutMs: number;
}

export function SettingsPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { m } = useI18n();

	// Auto-lock timeout options (in milliseconds)
	// -1 means never auto-lock
	const AUTO_LOCK_OPTIONS = [
		{ value: "60000", label: m.ext_settings_auto_lock_1_minute() },
		{ value: "300000", label: m.ext_settings_auto_lock_5_minutes() },
		{ value: "600000", label: m.ext_settings_auto_lock_10_minutes() },
		{ value: "900000", label: m.ext_settings_auto_lock_15_minutes() },
		{ value: "1800000", label: m.ext_settings_auto_lock_30_minutes() },
		{ value: "3600000", label: m.ext_settings_auto_lock_1_hour() },
		{ value: "-1", label: m.ext_settings_auto_lock_never() },
	] as const;

	const formatTimeout = (ms: number): string => {
		const option = AUTO_LOCK_OPTIONS.find((o) => o.value === String(ms));
		if (option) return option.label;
		if (ms === -1) return m.ext_settings_auto_lock_never();
		if (ms < 60000) return `${ms / 1000}s`;
		if (ms < 3600000) return `${ms / 60000}min`;
		return `${ms / 3600000}h`;
	};

	// Query for current auto-lock timeout
	const autoLockTimeoutQuery = useQuery({
		queryKey: ["autoLockTimeout"],
		queryFn: async () => {
			const timeout = await storage.getAutoLockTimeoutOrDefault();
			return timeout;
		},
	});
	const desktopStatusQuery = useQuery({
		queryKey: ["desktopStatus"],
		queryFn: async () => {
			return await new Promise<DesktopStatus | null>((resolve) => {
				chrome.runtime.sendMessage(
					{ type: "CHECK_DESKTOP_STATUS" },
					(response: DesktopStatus) => {
						resolve(response?.available ? response : null);
					},
				);
			});
		},
	});
	const autoLockTimeout = useMemo(
		() => String(autoLockTimeoutQuery.data ?? DEFAULT_AUTO_LOCK_TIMEOUT_MS),
		[autoLockTimeoutQuery.data],
	);
	const desktopStatus = desktopStatusQuery.data ?? null;

	const handleAutoLockTimeoutChange = async (value: string) => {
		const timeoutMs = Number.parseInt(value, 10);
		await storage.storeAutoLockTimeout(timeoutMs);
		queryClient.invalidateQueries({ queryKey: ["autoLockTimeout"] });
		toast.success(m.settings_auto_lock_toast_updated());

		// Notify background service worker that settings changed
		chrome.runtime.sendMessage({ type: "SETTINGS_CHANGED" });
	};

	const handleSignOut = async () => {
		try {
			const response = await chrome.runtime.sendMessage({ type: "LOGOUT" });
			if (response.success) {
				toast.success(m.ext_settings_toast_signed_out());
				navigate({ to: "/login" });
			} else {
				toast.error(m.ext_settings_toast_sign_out_failed());
			}
		} catch (error) {
			console.error("Sign out error:", error);
			toast.error(m.ext_settings_toast_sign_out_failed());
		}
	};

	return (
		<div className="flex h-full flex-col">
			<header className="border-b bg-background px-4 py-3">
				<div className="flex items-center gap-3">
					<Button
						variant="ghost"
						size="icon"
						onClick={() => navigate({ to: "/vault" })}
					>
						<IconArrowLeftOutlineDuo18 className="size-4" />
					</Button>
					<div className="flex items-center gap-3">
						<div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
							<IconGear3OutlineDuo18 className="size-4" />
						</div>
						<div>
							<div className="text-muted-foreground text-xs uppercase tracking-wide">
								Extension
							</div>
							<div className="font-semibold text-base">Settings</div>
						</div>
					</div>
				</div>
			</header>

			<main className="flex-1 overflow-y-auto p-6">
				<div className="space-y-6">
					{/* Security Section */}
					<div className="space-y-4">
						<h2 className="font-semibold text-lg">{m.ext_settings_section_security()}</h2>

						<div className="flex items-center justify-between rounded-lg border p-4">
							<div className="flex items-center gap-3">
								<div className="flex size-10 items-center justify-center rounded-lg bg-muted">
									<IconClockTimeOutlineDuo18 className="size-5 text-muted-foreground" />
								</div>
								<div>
									<Label className="font-medium text-sm">
										{m.ext_settings_auto_lock_label()}
									</Label>
									<p className="text-muted-foreground text-xs">
										{desktopStatus?.available
											? m.ext_settings_auto_lock_managed({ timeout: formatTimeout(desktopStatus.autolockTimeoutMs) })
											: m.ext_settings_auto_lock_description()}
									</p>
								</div>
							</div>
							<Select
								value={autoLockTimeout}
								onValueChange={handleAutoLockTimeoutChange}
								disabled={
									autoLockTimeoutQuery.isLoading ||
									desktopStatus?.available === true
								}
							>
								<SelectTrigger className="w-[140px]">
									<SelectValue placeholder={m.ext_settings_auto_lock_placeholder()} />
								</SelectTrigger>
								<SelectContent>
									{AUTO_LOCK_OPTIONS.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>

					{/* Account Section */}
					<div className="space-y-4">
						<h2 className="font-semibold text-lg">{m.ext_settings_section_account()}</h2>

						<div className="flex items-center justify-between rounded-lg border p-4">
							<div className="flex items-center gap-3">
								<div className="flex size-10 items-center justify-center rounded-lg bg-muted">
									<IconArrowDoorOutOutlineDuo18 className="size-5 text-muted-foreground" />
								</div>
								<div>
									<Label className="font-medium text-sm">{m.ext_settings_sign_out_label()}</Label>
									<p className="text-muted-foreground text-xs">
										{desktopStatus?.available
											? m.ext_settings_sign_out_managed()
											: m.ext_settings_sign_out_description()}
									</p>
								</div>
							</div>
							<Button
								variant="destructive"
								onClick={handleSignOut}
								disabled={desktopStatus?.available === true}
							>
								{m.ext_settings_sign_out_label()}
							</Button>
						</div>
					</div>
				</div>
			</main>
		</div>
	);
}
