import { Skeleton } from "heroui-native";
import { Fragment } from "react";
import { View } from "react-native";
import { layout } from "@/components/ui";

export interface ItemsSkeletonListProps {
	count?: number;
}

/** Placeholder that matches the grouped item card while items decrypt. */
export function ItemsSkeletonList({ count = 6 }: ItemsSkeletonListProps) {
	return (
		<View className="px-4 pt-6">
			<View className="overflow-hidden rounded-2xl border border-border bg-surface">
				{Array.from({ length: count }, (_, index) => index).map((index) => (
					<Fragment key={index}>
						{index > 0 ? <View className="ml-14 h-px bg-border" /> : null}
						<View
							className="flex-row items-center px-3.5"
							style={{ minHeight: layout.rowHeight }}
						>
							<Skeleton className="mr-3 h-10 w-10 rounded-xl" />
							<View className="flex-1 gap-2">
								<Skeleton className="h-3.5 w-32 rounded-full" />
								<Skeleton className="h-3 w-20 rounded-full" />
							</View>
						</View>
					</Fragment>
				))}
			</View>
		</View>
	);
}
