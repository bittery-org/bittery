import { Card, Chip, PressableFeedback } from "heroui-native";
import { ChevronRight } from "lucide-react-native";
import { View } from "react-native";
import { withUniwind } from "uniwind";

import { VaultAvatar } from "./vault-avatar";

const StyledChevronRight = withUniwind(ChevronRight);

interface VaultListItemProps {
	id: string;
	name: string;
	type: "personal" | "team";
	role: string;
	icon?: string | null;
	imageUrl?: string | null;
	itemCount?: number;
	accountLabel?: string;
	onPress: () => void;
	isFirstInSection?: boolean;
	isLastInSection?: boolean;
}

export function VaultListItem({
	id: _id,
	name,
	type,
	role,
	icon,
	imageUrl,
	itemCount,
	accountLabel,
	onPress,
	isFirstInSection = false,
	isLastInSection = false,
}: VaultListItemProps) {
	// Get subtitle based on vault info
	const subtitleParts = [
		accountLabel,
		type === "team" ? "Team vault" : "Personal vault",
		role,
		itemCount !== undefined
			? `${itemCount} item${itemCount !== 1 ? "s" : ""}`
			: null,
	].filter(Boolean);
	const subtitle = subtitleParts.join(" • ");

	// Determine rounded corners based on position
	const getCardRounding = () => {
		if (isFirstInSection && isLastInSection) {
			return "rounded-2xl"; // Single item
		}
		if (isFirstInSection) {
			return "rounded-t-2xl rounded-b-md"; // First item
		}
		if (isLastInSection) {
			return "rounded-t-md rounded-b-2xl"; // Last item
		}
		return "rounded-md"; // Middle item
	};

	return (
		<PressableFeedback onPress={onPress} className="mx-4 mb-1">
			<Card className={getCardRounding()}>
				<PressableFeedback.Ripple />
				<Card.Body className="flex-row items-center py-1 pr-3 pl-1.5">
					{/* Vault Avatar */}
					<View className="mr-3.5">
						<VaultAvatar
							name={name}
							icon={icon}
							imageUrl={imageUrl}
							size="sm"
						/>
					</View>

					{/* Content */}
					<View className="min-w-0 flex-1">
						<View className="flex-row items-center">
							<Card.Title className="shrink text-base" numberOfLines={1}>
								{name}
							</Card.Title>
							{type === "team" && (
								<View className="ml-2">
									<Chip variant="secondary" size="sm">
										<Chip.Label className="text-[10px]">Team</Chip.Label>
									</Chip>
								</View>
							)}
						</View>
						<Card.Description className="text-xs" numberOfLines={1}>
							{subtitle}
						</Card.Description>
					</View>

					{/* Chevron */}
					<StyledChevronRight size={18} className="ml-2 text-muted" />
				</Card.Body>
			</Card>
		</PressableFeedback>
	);
}
