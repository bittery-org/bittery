import { Shield, Users } from "lucide-react-native";
import { Text, View } from "react-native";
import { cn } from "@/lib/utils";

interface VaultBadgeProps {
	name: string;
	type: string;
	size?: "sm" | "md";
}

export function VaultBadge({ name, type, size = "sm" }: VaultBadgeProps) {
	const isTeam = type === "team";
	const iconSize = size === "sm" ? 10 : 12;
	const textSize = size === "sm" ? "text-xs" : "text-sm";

	return (
		<View
			className={cn(
				"flex-row",
				"items-center",
				"rounded-full",
				"px-2",
				"py-0.5",
				isTeam ? "bg-blue-100" : "bg-gray-100",
			)}
		>
			{isTeam ? (
				<Users size={iconSize} color="#3b82f6" />
			) : (
				<Shield size={iconSize} color="#6b7280" />
			)}
			<Text
				className={cn(
					"ml-1",
					textSize,
					isTeam ? "text-blue-600" : "text-gray-600",
				)}
				numberOfLines={1}
			>
				{name}
			</Text>
		</View>
	);
}
