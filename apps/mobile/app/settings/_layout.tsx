import { Stack } from "expo-router";
import { useThemeColor } from "heroui-native";

export default function SettingsLayout() {
  const [background] = useThemeColor(["background"]);

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: background },
      }}
    >
      <Stack.Screen name="index" />
    </Stack>
  );
}
