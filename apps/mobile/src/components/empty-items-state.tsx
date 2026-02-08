import { Button, Card } from "heroui-native";
import { Key } from "lucide-react-native";
import type { ReactNode } from "react";
import { View } from "react-native";
import { withUniwind } from "uniwind";

const StyledKey = withUniwind(Key);

export interface EmptyItemsStateProps {
	title: string;
	description: string;
	icon?: ReactNode;
	actionLabel?: string;
	onAction?: () => void;
}

/**
 * Empty state component for when no items are found.
 * Supports optional action button (e.g., "Add Item").
 */
export function EmptyItemsState({
	title,
	description,
	icon,
	actionLabel,
	onAction,
}: EmptyItemsStateProps) {
	return (
		<View className="flex-1 items-center justify-center p-8">
			<Card variant="secondary" className="w-full max-w-sm items-center p-8">
				{icon || <StyledKey size={48} className="mb-4 text-muted" />}
				<Card.Title className="mb-2 text-center text-lg">{title}</Card.Title>
				<Card.Description className="mb-4 text-center">
					{description}
				</Card.Description>
				{actionLabel && onAction && (
					<Button onPress={onAction} variant="primary">
						{actionLabel}
					</Button>
				)}
			</Card>
		</View>
	);
}
