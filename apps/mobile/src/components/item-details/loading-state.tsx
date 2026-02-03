import { Skeleton } from "heroui-native";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "../safe-area-view";

export function LoadingState() {
  return (
    <SafeAreaView className="flex-1 bg-background">
      {/* Header Skeleton */}
      <View className="border-border border-b px-4 py-4">
        <View className="flex-row items-center">
          <Skeleton className="mr-3 h-10 w-10 rounded-full" />
          <Skeleton className="mr-3 h-10 w-10 rounded-lg" />
          <View className="flex-1">
            <Skeleton className="mb-2 h-4 w-32 rounded" />
            <Skeleton className="h-3 w-24 rounded" />
          </View>
          <Skeleton className="h-9 w-16 rounded-lg" />
        </View>
      </View>

      {/* Content Skeleton */}
      <ScrollView className="flex-1 px-4">
        {[1, 2, 3, 4, 5].map((i) => (
          <View key={i} className="border-border border-b py-4">
            <Skeleton className="mb-2 h-3 w-20 rounded" />
            <Skeleton className="h-4 w-full rounded" />
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
