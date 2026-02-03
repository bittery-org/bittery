import { Stack } from "expo-router";
import { useThemeColor } from "heroui-native";

export default function VaultLayout() {
  const [background] = useThemeColor(["background"]);

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: background },
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="[vaultId]/index" />
      <Stack.Screen name="[vaultId]/[itemId]" />
      <Stack.Screen name="create" />
    </Stack>
  );
}
