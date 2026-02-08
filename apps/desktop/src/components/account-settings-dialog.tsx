import {
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
	const [autoLockTimeout, setAutoLockTimeout] = useState(
		String(DEFAULT_AUTO_LOCK_TIMEOUT_MS),
	);
	const [isDirty, setIsDirty] = useState(false);

	// Query for auto-lock timeout
	const autoLockTimeoutQuery = useQuery({
		queryKey: ["autoLockTimeout", email],
		queryFn: async () => {
			const timeout = await storage.getAutoLockTimeoutOrDefault(email);
			return timeout;
		},
		enabled: open,
	});

	// Reset form when dialog opens or data loads
	useEffect(() => {
		if (open) {
			if (autoLockTimeoutQuery.data !== undefined) {
				setAutoLockTimeout(String(autoLockTimeoutQuery.data));
			}
			setIsDirty(false);
		}
	}, [open, autoLockTimeoutQuery.data]);

	// Mutation to save settings
	const saveMutation = useMutation({
		mutationFn: async ({ timeout }: { timeout: string }) => {
			// Save auto-lock timeout
			const timeoutMs = Number.parseInt(timeout, 10);
			await storage.storeAutoLockTimeout(timeoutMs, email);
		},
		onSuccess: () => {
			toast.success("Settings saved successfully");
			queryClient.invalidateQueries({ queryKey: ["autoLockTimeout", email] });
			setIsDirty(false);
			onOpenChange(false);
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	const handleSave = () => {
		saveMutation.mutate({ timeout: autoLockTimeout });
	};

	const handleClose = () => {
		if (isDirty) {
			// Reset to original values
			setAutoLockTimeout(
				String(autoLockTimeoutQuery.data ?? DEFAULT_AUTO_LOCK_TIMEOUT_MS),
			);
			setIsDirty(false);
		}
		onOpenChange(false);
	};

	const handleAutoLockTimeoutChange = (value: string) => {
		setAutoLockTimeout(value);
		setIsDirty(true);
	};

	const isLoading = autoLockTimeoutQuery.isLoading;

	return (
		<Dialog open={open} onOpenChange={handleClose}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Account Settings</DialogTitle>
					<DialogDescription>Configure settings for {email}</DialogDescription>
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
	);
}
