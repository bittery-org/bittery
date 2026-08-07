import { Text, View } from "react-native";
import { IconUsers, IconVault } from "@/components/ui";

interface VaultBadgeProps {
	name: string;
	type: string;
	size?: "sm" | "md";
}

/** Neutral chip naming the vault an item lives in. Never status-coloured. */
export function VaultBadge({ name, type, size = "sm" }: VaultBadgeProps) {
	const isShared = type === "team";
	const glyph = size === "sm" ? 10 : 12;
	const Icon = isShared ? IconUsers : IconVault;

	return (
		<View className="max-w-[45%] shrink-0 flex-row items-center gap-1 rounded-full border border-border bg-surface-secondary px-1.5 py-0.5">
			<Icon size={glyph} className="text-muted" />
			<Text
				numberOfLines={1}
				className={size === "sm" ? "text-2xs text-muted" : "text-muted text-xs"}
			>
				{name}
			</Text>
		</View>
	);
}
