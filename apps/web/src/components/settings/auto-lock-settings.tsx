import { DEFAULT_AUTO_LOCK_TIMEOUT_MS } from "@bittery/storage";
import {
	Label,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	toast,
} from "@bittery/ui";
import { useEffect, useState } from "react";
import { storage } from "@/lib/storage";

// Auto-lock timeout options (in milliseconds)
// -1 means never auto-lock
export const AUTO_LOCK_OPTIONS = [
	{ value: "60000", label: "1 minute" },
	{ value: "300000", label: "5 minutes" },
	{ value: "600000", label: "10 minutes" },
	{ value: "900000", label: "15 minutes" },
	{ value: "1800000", label: "30 minutes" },
	{ value: "3600000", label: "1 hour" },
	{ value: "-1", label: "Never" },
] as const;

export function AutoLockSettings() {
	const [selectedTimeout, setSelectedTimeout] = useState<string>(
		String(DEFAULT_AUTO_LOCK_TIMEOUT_MS),
	);
	const [isLoading, setIsLoading] = useState(true);

	// Load current setting on mount
	useEffect(() => {
		const loadTimeout = async () => {
			const timeout = await storage.getAutoLockTimeoutOrDefault();
			setSelectedTimeout(String(timeout));
			setIsLoading(false);
		};
		loadTimeout();
	}, []);

	const handleTimeoutChange = async (value: string) => {
		const timeoutMs = Number.parseInt(value, 10);
		await storage.storeAutoLockTimeout(timeoutMs);
		setSelectedTimeout(value);
		toast.success("Auto-lock timeout updated");
	};

	if (isLoading) {
		return (
			<div className="flex items-center justify-between">
				<div className="space-y-1">
					<Label className="font-medium text-sm">Auto-Lock Timeout</Label>
					<p className="text-muted-foreground text-sm">Loading...</p>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
			<div className="space-y-1">
				<Label className="font-medium text-sm">Auto-Lock Timeout</Label>
				<p className="text-muted-foreground text-sm">
					Automatically lock your vault after a period of inactivity
				</p>
			</div>
			<Select value={selectedTimeout} onValueChange={handleTimeoutChange}>
				<SelectTrigger className="w-[180px]">
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
	);
}
