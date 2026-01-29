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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	ArrowLeft,
	Clock,
	LogOut,
	Settings as SettingsIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { DEFAULT_AUTO_LOCK_TIMEOUT_MS, storage } from "../lib/storage";

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

// Format timeout milliseconds to human-readable string
function formatTimeout(ms: number): string {
	if (ms === -1) return "Never";
	if (ms < 60000) return `${ms / 1000} seconds`;
	if (ms < 3600000) return `${ms / 60000} minutes`;
	return `${ms / 3600000} hour${ms / 3600000 > 1 ? "s" : ""}`;
}

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
	const [autoLockTimeout, setAutoLockTimeout] = useState(
		String(DEFAULT_AUTO_LOCK_TIMEOUT_MS),
	);
	const [desktopStatus, setDesktopStatus] = useState<DesktopStatus | null>(
		null,
	);

	// Query for current auto-lock timeout
	const autoLockTimeoutQuery = useQuery({
		queryKey: ["autoLockTimeout"],
		queryFn: async () => {
			const timeout = await storage.getAutoLockTimeoutOrDefault();
			return timeout;
		},
	});

	// Update state when query data loads
	useEffect(() => {
		if (autoLockTimeoutQuery.data !== undefined) {
			setAutoLockTimeout(String(autoLockTimeoutQuery.data));
		}
	}, [autoLockTimeoutQuery.data]);

	// Check desktop status on page load
	useEffect(() => {
		chrome.runtime.sendMessage(
			{ type: "CHECK_DESKTOP_STATUS" },
			(response: DesktopStatus) => {
				if (response?.available) {
					setDesktopStatus(response);
				}
			},
		);
	}, []);

	const handleAutoLockTimeoutChange = async (value: string) => {
		const timeoutMs = Number.parseInt(value, 10);
		await storage.storeAutoLockTimeout(timeoutMs);
		setAutoLockTimeout(value);
		queryClient.invalidateQueries({ queryKey: ["autoLockTimeout"] });
		toast.success("Auto-lock timeout updated");

		// Notify background service worker that settings changed
		chrome.runtime.sendMessage({ type: "SETTINGS_CHANGED" });
	};

	const handleSignOut = async () => {
		try {
			const response = await chrome.runtime.sendMessage({ type: "LOGOUT" });
			if (response.success) {
				toast.success("Signed out successfully");
				navigate({ to: "/login" });
			} else {
				toast.error("Failed to sign out");
			}
		} catch (error) {
			console.error("Sign out error:", error);
			toast.error("Failed to sign out");
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
						<ArrowLeft className="size-4" />
					</Button>
					<div className="flex items-center gap-3">
						<div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
							<SettingsIcon className="size-4" />
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
						<h2 className="font-semibold text-lg">Security</h2>

						{/* Desktop Connection Status */}
						{desktopStatus !== null && (
							<div className="rounded-md border p-3">
								<div className="flex items-center gap-2 text-sm">
									<div
										className={`size-2 rounded-full ${
											desktopStatus.available ? "bg-green-500" : "bg-gray-400"
										}`}
									/>
									<span className="text-muted-foreground">
										{desktopStatus.available
											? `Desktop app connected (auto-lock: ${formatTimeout(desktopStatus.autolockTimeoutMs)})`
											: "Desktop app not running"}
									</span>
								</div>
							</div>
						)}

						<div className="flex items-center justify-between rounded-lg border p-4">
							<div className="flex flex-1 flex-col gap-3">
								<div className="flex items-center gap-3">
									<div className="flex size-10 items-center justify-center rounded-lg bg-muted">
										<Clock className="size-5 text-muted-foreground" />
									</div>
									<div>
										<Label className="font-medium text-sm">
											Auto-Lock Timeout
										</Label>
										<p className="text-muted-foreground text-xs">
											{desktopStatus?.available
												? "Managed by desktop app"
												: "Lock your vault after inactivity"}
										</p>
									</div>
								</div>
								{desktopStatus?.available && (
									<div className="ml-13 rounded-md bg-muted p-3 text-sm">
										<p className="text-muted-foreground">
											Using desktop app timeout:{" "}
											<span className="font-medium text-foreground">
												{formatTimeout(desktopStatus.autolockTimeoutMs)}
											</span>
										</p>
										<p className="mt-1 text-muted-foreground text-xs">
											Extension timeout is only used when desktop app is not
											running
										</p>
									</div>
								)}
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
						</div>
					</div>

					{/* Account Section */}
					<div className="space-y-4">
						<h2 className="font-semibold text-lg">Account</h2>

						<div className="flex items-center justify-between rounded-lg border p-4">
							<div className="flex items-center gap-3">
								<div className="flex size-10 items-center justify-center rounded-lg bg-muted">
									<LogOut className="size-5 text-muted-foreground" />
								</div>
								<div>
									<Label className="font-medium text-sm">Sign Out</Label>
									<p className="text-muted-foreground text-xs">
										Sign out of your account on this device
									</p>
								</div>
							</div>
							<Button variant="destructive" onClick={handleSignOut}>
								Sign Out
							</Button>
						</div>
					</div>
				</div>
			</main>
		</div>
	);
}
