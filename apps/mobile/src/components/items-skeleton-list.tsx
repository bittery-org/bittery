import { Card, Skeleton } from "heroui-native";
import { View } from "react-native";

export interface ItemsSkeletonListProps {
	count?: number;
}

/**
 * Skeleton loading state for item lists.
 */
export function ItemsSkeletonList({ count = 6 }: ItemsSkeletonListProps) {
	return (
		<View className="flex-1 py-2">
			{Array.from({ length: count }).map((_, index) => (
				<Card key={index} className="mx-4 mb-2">
					<Card.Body className="flex-row items-center py-3">
						<Skeleton className="mr-3 h-10 w-10 rounded-lg" />
						<View className="flex-1">
							<Skeleton className="mb-2 h-4 w-32 rounded" />
							<Skeleton className="h-3 w-24 rounded" />
						</View>
					</Card.Body>
				</Card>
			))}
		</View>
	);
}
