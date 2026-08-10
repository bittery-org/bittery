import { Skeleton } from "heroui-native";
import { ScrollView, View } from "react-native";
import { AppBar, Screen, useBottomInset } from "@/components/ui";

const FIELD_PLACEHOLDERS = ["username", "password", "website", "notes"];

export function LoadingState() {
	const bottomInset = useBottomInset();

	return (
		<Screen>
			<AppBar showBack />
			<ScrollView
				className="flex-1"
				contentContainerStyle={{
					paddingHorizontal: 16,
					paddingBottom: bottomInset,
				}}
			>
				<View className="items-center pt-2 pb-6">
					<Skeleton className="h-14 w-14 rounded-2xl" />
					<Skeleton className="mt-4 h-6 w-40 rounded-lg" />
					<Skeleton className="mt-2 h-3 w-20 rounded-lg" />
				</View>
				<View className="gap-px overflow-hidden rounded-2xl border border-border bg-surface">
					{FIELD_PLACEHOLDERS.map((placeholder) => (
						<View key={placeholder} className="px-4 py-4">
							<Skeleton className="h-2.5 w-16 rounded" />
							<Skeleton className="mt-2 h-4 w-48 rounded" />
						</View>
					))}
				</View>
			</ScrollView>
		</Screen>
	);
}
