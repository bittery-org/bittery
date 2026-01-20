import { normalizeServerUrl } from "@bittery/crypto/server-url";
import * as tauriStorage from "@bittery/crypto/storage-tauri";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	Label,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Separator,
	toast,
} from "@bittery/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

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

interface AccountSettingsDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	email: string;
}

export function AccountSettingsDialog({
	open,
	onOpenChange,
	email,
}: AccountSettingsDialogProps) {
	const queryClient = useQueryClient();
	const [webAppUrl, setWebAppUrl] = useState("");
	const [autoLockTimeout, setAutoLockTimeout] = useState(
		String(tauriStorage.DEFAULT_AUTO_LOCK_TIMEOUT_MS),
	);
	const [isDirty, setIsDirty] = useState(false);

	// Query for auto-lock timeout
	const autoLockTimeoutQuery = useQuery({
		queryKey: ["autoLockTimeout", email],
		queryFn: async () => {
			const timeout = await tauriStorage.getAutoLockTimeoutOrDefault(email);
			return timeout;
		},
		enabled: open,
	});

	// Query for current web app URL
	const webAppUrlQuery = useQuery({
		queryKey: ["webAppUrl", email],
		queryFn: async () => {
			const url = await tauriStorage.getWebAppUrl(email);
			return url;
		},
		enabled: open,
	});

	// Query for server URL (to show derived URL)
	const serverUrlQuery = useQuery({
		queryKey: ["serverUrl"],
		queryFn: async () => {
			return await tauriStorage.getServerUrl();
		},
		enabled: open,
	});

	// Derive the default web app URL from server URL
	const derivedWebAppUrl = serverUrlQuery.data
		? serverUrlQuery.data.replace(/\/api.*$/, "").replace(/\/$/, "")
		: "https://app.bittery.io";

	// Reset form when dialog opens or data loads
	useEffect(() => {
		if (open) {
			if (webAppUrlQuery.data !== undefined) {
				setWebAppUrl(webAppUrlQuery.data || "");
			}
			if (autoLockTimeoutQuery.data !== undefined) {
				setAutoLockTimeout(String(autoLockTimeoutQuery.data));
			}
			setIsDirty(false);
		}
	}, [open, webAppUrlQuery.data, autoLockTimeoutQuery.data]);

	// Mutation to save settings
	const saveMutation = useMutation({
		mutationFn: async ({
			url,
			timeout,
		}: { url: string; timeout: string }) => {
			// Save web app URL
			if (url.trim()) {
				// Normalize the URL
				const normalized = normalizeServerUrl(url);
				if (!normalized) {
					throw new Error("Invalid URL format");
				}
				await tauriStorage.storeWebAppUrl(normalized, email);
			} else {
				// Clear the custom URL to use derived URL
				await tauriStorage.clearWebAppUrl(email);
			}

			// Save auto-lock timeout
			const timeoutMs = Number.parseInt(timeout, 10);
			await tauriStorage.storeAutoLockTimeout(timeoutMs, email);
		},
		onSuccess: () => {
			toast.success("Settings saved successfully");
			queryClient.invalidateQueries({ queryKey: ["webAppUrl", email] });
			queryClient.invalidateQueries({ queryKey: ["autoLockTimeout", email] });
			setIsDirty(false);
			onOpenChange(false);
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	const handleSave = () => {
		saveMutation.mutate({ url: webAppUrl, timeout: autoLockTimeout });
	};

	const handleReset = () => {
		setWebAppUrl("");
		setIsDirty(true);
	};

	const handleClose = () => {
		if (isDirty) {
			// Reset to original values
			setWebAppUrl(webAppUrlQuery.data || "");
			setAutoLockTimeout(
				String(
					autoLockTimeoutQuery.data ?? tauriStorage.DEFAULT_AUTO_LOCK_TIMEOUT_MS,
				),
			);
			setIsDirty(false);
		}
		onOpenChange(false);
	};

	const handleUrlChange = (value: string) => {
		setWebAppUrl(value);
		setIsDirty(true);
	};

	const handleAutoLockTimeoutChange = (value: string) => {
		setAutoLockTimeout(value);
		setIsDirty(true);
	};

	const isLoading =
		webAppUrlQuery.isLoading ||
		serverUrlQuery.isLoading ||
		autoLockTimeoutQuery.isLoading;

	return (
		<Dialog open={open} onOpenChange={handleClose}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Account Settings</DialogTitle>
					<DialogDescription>Configure settings for {email}</DialogDescription>
				</DialogHeader>

				{isLoading ? (
					<div className="flex items-center justify-center py-8">
						<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
					</div>
				) : (
					<div className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="webAppUrl">Web App URL</Label>
							<Input
								id="webAppUrl"
								type="url"
								value={webAppUrl}
								onChange={(e) => handleUrlChange(e.target.value)}
								placeholder={derivedWebAppUrl}
							/>
							<p className="text-muted-foreground text-xs">
								The URL used for shareable links. Leave empty to use the derived
								URL from your server URL.
							</p>
							{!webAppUrl && (
								<p className="text-muted-foreground text-xs">
									Current derived URL:{" "}
									<code className="rounded bg-muted px-1 py-0.5">
										{derivedWebAppUrl}
									</code>
								</p>
							)}
						</div>

						{webAppUrl && (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={handleReset}
							>
								Reset to Default
							</Button>
						)}

						<Separator />

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
					</div>
				)}

				<DialogFooter>
					<Button variant="outline" onClick={handleClose}>
						Cancel
					</Button>
					<Button
						onClick={handleSave}
						disabled={saveMutation.isPending || !isDirty}
					>
						{saveMutation.isPending ? (
							<>
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								Saving...
							</>
						) : (
							"Save"
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
