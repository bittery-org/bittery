import { DEFAULT_AUTO_LOCK_TIMEOUT_MS } from "@bittery/storage";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	toast,
} from "@bittery/ui";
import { useQuery } from "@tanstack/react-query";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

// Auto-lock timeout options (in milliseconds)
// -1 means never auto-lock
export const AUTO_LOCK_OPTIONS = [
	{ value: "60000", unit: "minute" },
	{ value: "300000", unit: "minute" },
	{ value: "600000", unit: "minute" },
	{ value: "900000", unit: "minute" },
	{ value: "1800000", unit: "minute" },
	{ value: "3600000", unit: "hour" },
	{ value: "-1", unit: "never" },
] as const;

export function AutoLockSettings() {
	const { m } = useI18n();
	const autoLockTimeoutQuery = useQuery({
		queryKey: ["web-settings", "auto-lock-timeout"],
		queryFn: () => storage.getAutoLockTimeoutOrDefault(),
	});
	const selectedTimeout = String(
		autoLockTimeoutQuery.data ?? DEFAULT_AUTO_LOCK_TIMEOUT_MS,
	);

	const handleTimeoutChange = async (value: string) => {
		const timeoutMs = Number.parseInt(value, 10);
		await storage.storeAutoLockTimeout(timeoutMs);
		toast.success(m["settings.auto_lock.toast.updated"]());
	};

	const getOptionLabel = (option: (typeof AUTO_LOCK_OPTIONS)[number]) => {
		if (option.unit === "never") {
			return m["settings.auto_lock.option.never"]();
		}
		const count =
			option.unit === "hour"
				? Number(option.value) / 3_600_000
				: Number(option.value) / 60_000;
		if (option.unit === "hour") {
			return count === 1
				? m["settings.auto_lock.option.hours.single"]({ count })
				: m["settings.auto_lock.option.hours.plural"]({ count });
		}
		return count === 1
			? m["settings.auto_lock.option.minutes.single"]({ count })
			: m["settings.auto_lock.option.minutes.plural"]({ count });
	};

	return (
		<Select
			value={autoLockTimeoutQuery.isLoading ? undefined : selectedTimeout}
			onValueChange={handleTimeoutChange}
			disabled={autoLockTimeoutQuery.isLoading}
		>
			<SelectTrigger className="w-full sm:w-45">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{AUTO_LOCK_OPTIONS.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						{getOptionLabel(option)}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
