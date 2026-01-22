import { Tag } from "lucide-react-native";
import { Text, TouchableOpacity, View } from "react-native";

interface TagChipProps {
	name: string;
	count?: number;
	onPress?: () => void;
	size?: "sm" | "md";
	selected?: boolean;
}

// Generate a consistent color based on tag name
function getTagColor(name: string): { bg: string; text: string; icon: string } {
	const colors = [
		{ bg: "bg-red-100", text: "text-red-700", icon: "#b91c1c" },
		{ bg: "bg-orange-100", text: "text-orange-700", icon: "#c2410c" },
		{ bg: "bg-amber-100", text: "text-amber-700", icon: "#b45309" },
		{ bg: "bg-yellow-100", text: "text-yellow-700", icon: "#a16207" },
		{ bg: "bg-lime-100", text: "text-lime-700", icon: "#4d7c0f" },
		{ bg: "bg-green-100", text: "text-green-700", icon: "#15803d" },
		{ bg: "bg-emerald-100", text: "text-emerald-700", icon: "#047857" },
		{ bg: "bg-teal-100", text: "text-teal-700", icon: "#0f766e" },
		{ bg: "bg-cyan-100", text: "text-cyan-700", icon: "#0e7490" },
		{ bg: "bg-sky-100", text: "text-sky-700", icon: "#0369a1" },
		{ bg: "bg-blue-100", text: "text-blue-700", icon: "#1d4ed8" },
		{ bg: "bg-indigo-100", text: "text-indigo-700", icon: "#4338ca" },
		{ bg: "bg-violet-100", text: "text-violet-700", icon: "#6d28d9" },
		{ bg: "bg-purple-100", text: "text-purple-700", icon: "#7e22ce" },
		{ bg: "bg-fuchsia-100", text: "text-fuchsia-700", icon: "#a21caf" },
		{ bg: "bg-pink-100", text: "text-pink-700", icon: "#be185d" },
		{ bg: "bg-rose-100", text: "text-rose-700", icon: "#be123c" },
	];

	// Simple hash based on tag name
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = name.charCodeAt(i) + ((hash << 5) - hash);
	}
	const index = Math.abs(hash) % colors.length;
	return colors[index];
}

export function TagChip({
	name,
	count,
	onPress,
	size = "md",
	selected = false,
}: TagChipProps) {
	const color = getTagColor(name);
	const iconSize = size === "sm" ? 12 : 14;
	const padding = size === "sm" ? "px-2 py-1" : "px-3 py-2";
	const textSize = size === "sm" ? "text-xs" : "text-sm";

	const content = (
		<View
			className={`flex-row items-center rounded-full ${padding} ${
				selected ? "bg-primary" : color.bg
			}`}
		>
			<Tag size={iconSize} color={selected ? "#fff" : color.icon} />
			<Text
				className={`ml-1.5 font-medium ${textSize} ${
					selected ? "text-primary-foreground" : color.text
				}`}
			>
				{name}
			</Text>
			{count !== undefined && (
				<View
					className={`ml-1.5 rounded-full px-1.5 ${
						selected ? "bg-white/20" : "bg-black/10"
					}`}
				>
					<Text
						className={`font-medium text-xs ${
							selected ? "text-primary-foreground" : color.text
						}`}
					>
						{count}
					</Text>
				</View>
			)}
		</View>
	);

	if (onPress) {
		return (
			<TouchableOpacity onPress={onPress} activeOpacity={0.7}>
				{content}
			</TouchableOpacity>
		);
	}

	return content;
}
