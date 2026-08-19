import { useAccountSwitcher } from "@bittery/core/hooks";
import {
	Button,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	toast,
} from "@bittery/ui";
import {
	IconChevronLeft,
	IconLogOut,
	IconMonitor,
	IconMoon,
	IconSun,
} from "@bittery/ui/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { sendMessage } from "../lib/messaging";
import { DEFAULT_AUTO_LOCK_TIMEOUT_MS, storage } from "../lib/storage";
import { useI18n } from "../providers/i18n-provider";
import { useTheme } from "../providers/theme-provider";

const GROUP_LABEL_CLASS =
	"mb-1.5 block px-0.5 font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]";
const FIELD_CARD_CLASS = "overflow-hidden rounded-lg border bg-card";
const ROW_CLASS =
	"flex min-h-[52px] items-center gap-3 px-3 py-2.5 [&+&]:border-t";
const TITLE_CLASS =
	"flex items-center gap-1.5 font-medium text-[12.5px] text-foreground";
const DESC_CLASS = "mt-px text-[11.5px] text-muted-foreground";
const MANAGED_CHIP_CLASS =
	"inline-flex h-[18px] items-center gap-1 rounded-full border border-info/30 bg-info/10 px-1.5 font-semibold text-[10px] text-info";

function ManagedChip({ label }: { label: string }) {
	return (
		<span className={MANAGED_CHIP_CLASS}>
			<IconMonitor className="size-2.5" />
			{label}
		</span>
	);
}

export function SettingsPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { m } = useI18n();
	const { theme, setTheme, isDesktopManaged } = useTheme();
	const { accounts, activeAccount: activeSelection } = useAccountSwitcher();

	const activeAccountId = activeSelection ?? null;
	const activeAccount = accounts.find((a) => a.accountId === activeAccountId);

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

	const THEME_OPTIONS = [
		{ value: "light", label: m.ext_settings_theme_light(), Icon: IconSun },
		{ value: "dark", label: m.ext_settings_theme_dark(), Icon: IconMoon },
		{
			value: "system",
			label: m.ext_settings_theme_system(),
			Icon: IconMonitor,
		},
	] as const;

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
			const response = await sendMessage({
				type: "CHECK_DESKTOP_STATUS",
			}).catch(() => null);
			return response?.success && response.available ? response : null;
		},
	});
	const autoLockTimeout = useMemo(
		() => String(autoLockTimeoutQuery.data ?? DEFAULT_AUTO_LOCK_TIMEOUT_MS),
		[autoLockTimeoutQuery.data],
	);
	const desktopStatus = desktopStatusQuery.data ?? null;
	const desktopAvailable = desktopStatus?.available === true;

	const handleAutoLockTimeoutChange = async (value: string) => {
		const timeoutMs = Number.parseInt(value, 10);
		await storage.storeAutoLockTimeout(timeoutMs);
		queryClient.invalidateQueries({ queryKey: ["autoLockTimeout"] });
		toast.success(m.settings_auto_lock_toast_updated());

		// Notify background service worker that settings changed
		void sendMessage({ type: "SETTINGS_CHANGED" });
	};

	const handleSignOut = async () => {
		try {
			const response = await sendMessage({ type: "LOGOUT" });
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
		<div className="flex h-full flex-col bg-background">
			<header className="flex h-12 flex-none items-center gap-2 border-b px-3">
				<Button
					variant="ghost"
					size="icon"
					className="size-8"
					aria-label={m.ext_settings_back()}
					onClick={() => navigate({ to: "/vault" })}
				>
					<IconChevronLeft className="size-4" />
				</Button>
				<h1 className="font-semibold text-[13.5px]">
					{m.ext_settings_label_settings()}
				</h1>
			</header>

			<div className="flex-1 overflow-y-auto px-[18px] pt-4 pb-6">
				{/* Appearance Section */}
				<section className="mx-auto mb-4 max-w-[460px]">
					<span className={GROUP_LABEL_CLASS}>
						{m.ext_settings_section_appearance()}
					</span>
					<div className={FIELD_CARD_CLASS}>
						<div className={ROW_CLASS}>
							<div className="min-w-0 flex-1">
								<div className={TITLE_CLASS}>
									{m.ext_settings_theme_label()}
									{isDesktopManaged && (
										<ManagedChip label={m.ext_settings_managed_badge()} />
									)}
								</div>
								<div className={DESC_CLASS}>
									{isDesktopManaged
										? m.ext_settings_theme_managed_description()
										: m.ext_settings_theme_description()}
								</div>
							</div>
							<div
								className={`flex gap-0.5 rounded-lg border bg-input p-[2.5px] ${
									isDesktopManaged ? "pointer-events-none opacity-55" : ""
								}`}
							>
								{THEME_OPTIONS.map(({ value, label, Icon }) => {
									const active = theme === value;
									return (
										<button
											key={value}
											type="button"
											disabled={isDesktopManaged}
											aria-pressed={active}
											onClick={() => setTheme(value)}
											className={`inline-flex h-6 items-center gap-1.5 rounded-md px-2.5 font-medium text-[11.5px] transition-colors ${
												active
													? "bg-overlay text-foreground shadow-[0_1px_3px_oklch(0_0_0/0.25),inset_0_0_0_1px_var(--border)]"
													: "text-muted-foreground hover:text-foreground"
											}`}
										>
											<Icon className="size-3" />
											{label}
										</button>
									);
								})}
							</div>
						</div>
					</div>
				</section>

				{/* Security Section */}
				<section className="mx-auto mb-4 max-w-[460px]">
					<span className={GROUP_LABEL_CLASS}>
						{m.ext_settings_section_security()}
					</span>
					<div className={FIELD_CARD_CLASS}>
						<div className={ROW_CLASS}>
							<div className="min-w-0 flex-1">
								<div className={TITLE_CLASS}>
									{m.ext_settings_auto_lock_label()}
									{desktopAvailable && (
										<ManagedChip label={m.ext_settings_managed_badge()} />
									)}
								</div>
								<div className={DESC_CLASS}>
									{m.ext_settings_auto_lock_row_description()}
								</div>
							</div>
							<Select
								value={autoLockTimeout}
								onValueChange={handleAutoLockTimeoutChange}
								disabled={autoLockTimeoutQuery.isLoading || desktopAvailable}
							>
								<SelectTrigger className="h-7 w-[130px]">
									<SelectValue
										placeholder={m.ext_settings_auto_lock_placeholder()}
									/>
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
				</section>

				{/* Account Section */}
				<section className="mx-auto mb-4 max-w-[460px]">
					<span className={GROUP_LABEL_CLASS}>
						{m.ext_settings_section_account()}
					</span>
					<div className={FIELD_CARD_CLASS}>
						<div className={ROW_CLASS}>
							<div className="min-w-0 flex-1">
								<div className={`${TITLE_CLASS} truncate`}>
									{activeAccount?.email ?? ""}
								</div>
								<div className={DESC_CLASS}>
									{activeAccount?.teamName
										? m.ext_settings_account_signed_in_with_team({
												team: activeAccount.teamName,
											})
										: m.ext_settings_account_signed_in()}
								</div>
							</div>
							<Button
								variant="destructive"
								size="sm"
								className="h-7 gap-1.5"
								onClick={handleSignOut}
								disabled={desktopAvailable}
							>
								<IconLogOut className="size-3" />
								{m.ext_settings_sign_out_label()}
							</Button>
						</div>
					</div>
					{desktopAvailable && (
						<div className="mt-2 flex items-center gap-1.5 px-0.5 text-[11.5px] text-muted-foreground">
							<IconMonitor className="size-3 text-info" />
							{m.ext_settings_desktop_note()}
						</div>
					)}
				</section>
			</div>
		</div>
	);
}
