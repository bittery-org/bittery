import { useLogin } from "@bittery/hooks";
import { normalizeServerUrl } from "@bittery/shared/server-url";
import { useRouter } from "expo-router";
import {
  Eye,
  EyeOff,
  Fingerprint,
  Lock,
  Mail,
  Server,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  View,
  Pressable
} from "react-native";
import { Button, TextField, Switch, FormField } from "heroui-native";
import { withUniwind } from "uniwind";
import { useAccount } from "../../src/contexts/account-context";
import { useServerUrl } from "../../src/lib/trpc";
import { type AccountMetadata, storage } from "../../src/services/storage";
import { SafeAreaView } from "@/components/safe-area-view";

const DEFAULT_SERVER_URL =
  process.env.EXPO_PUBLIC_SERVER_URL || "http://localhost:3000";

// Create styled icon components
const StyledServer = withUniwind(Server);
const StyledMail = withUniwind(Mail);
const StyledLock = withUniwind(Lock);
const StyledEye = withUniwind(Eye);
const StyledEyeOff = withUniwind(EyeOff);
const StyledFingerprint = withUniwind(Fingerprint);

export default function LoginScreen() {
  const router = useRouter();
  const { setServerUrl: setGlobalServerUrl } = useServerUrl();
  const { refreshAccounts } = useAccount();

  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [enableBiometric, setEnableBiometric] = useState(true);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricType, setBiometricType] = useState<string | null>(null);
  const [biometricDetails, setBiometricDetails] = useState<{
    hasHardware: boolean;
    isEnrolled: boolean;
  }>({ hasHardware: false, isEnrolled: false });

  useEffect(() => {
    async function checkBiometric() {
      const details = await storage.getBiometricAvailabilityDetails();
      setBiometricDetails({
        hasHardware: details.hasHardware,
        isEnrolled: details.isEnrolled,
      });

      // Biometric is only "available" if hardware exists AND biometrics are enrolled
      const available = details.hasHardware && details.isEnrolled;
      setBiometricAvailable(available);

      if (available) {
        const type = await storage.getBiometricType();
        setBiometricType(type);
      }
    }
    checkBiometric();
  }, []);

  // Use the shared login hook
  const loginMutation = useLogin({
    enableBiometric: enableBiometric && biometricAvailable,
    onSuccess: async (result, input) => {
      const normalizedEmail = input.email.toLowerCase();
      const normalizedServerUrl = normalizeServerUrl(serverUrl);

      // Store server URL per-account (mobile-specific)
      if (normalizedServerUrl) {
        await storage.storeServerUrl(normalizedServerUrl, normalizedEmail);
      }

      // Create account metadata (mobile-specific multi-account support)
      const secretKeyHint = `${input.secretKey.substring(0, 5)}...`;
      const accountMetadata: AccountMetadata = {
        email: normalizedEmail,
        userId: result.user.id,
        name: result.user.name || normalizedEmail.split("@")[0],
        teamName: result.user.teamName,
        secretKeyHint,
        addedAt: Date.now(),
        lastActiveAt: Date.now(),
        biometricEnabled: enableBiometric && biometricAvailable,
      };

      // Add to accounts list
      await storage.addAccountToList(accountMetadata);

      // Refresh account context
      await refreshAccounts();

      // Navigate to vault
      router.replace("/(vault)");
    },
    onError: (error) => {
      Alert.alert(
        "Error",
        error instanceof Error ? error.message : "Login failed",
      );
    },
  });

  const handleLogin = async () => {
    if (!email.trim() || !password.trim() || !secretKey.trim()) {
      Alert.alert("Error", "Please fill in all fields");
      return;
    }

    const normalizedServerUrl = normalizeServerUrl(serverUrl);
    if (!normalizedServerUrl) {
      Alert.alert("Error", "Invalid server URL");
      return;
    }

    // Update global server URL
    setGlobalServerUrl(normalizedServerUrl);

    // Allow UI to re-render and show loading state before heavy crypto work
    await new Promise((resolve) => setTimeout(resolve, 50));

    await loginMutation.mutateAsync({
      email,
      password,
      secretKey,
      enableBiometric: enableBiometric && biometricAvailable,
    });
  };

  return (
    <SafeAreaView className="flex-1 bg-background">
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
		contentContainerClassName="flex-1"
		className="flex-1"
      >
        <ScrollView
          className="flex-1"
		  contentContainerClassName="flex-1"
          keyboardShouldPersistTaps="handled"
        >
          <View className="flex-1 justify-center px-6 py-8">
            {/* Header */}
            <View className="mb-8 items-center">
              <Button
                isIconOnly
                variant="primary"
                size="lg"
                className="mb-4 h-20 w-20 rounded-2xl"
                onPress={() => {
                  // DEV ONLY: Auto-fill credentials
                  setEmail("j.sigmund@qrawall.com");
                  setPassword("Hofmann01");
                  setSecretKey("A3-L2OFDR-LDNVBB-CYKMG-SFWAO-QIID3");
                }}
              >
                <Lock size={40} color="#fff" />
              </Button>
              <Text className="font-bold text-2xl text-foreground">
                Sign in to Bittery
              </Text>
              <Text className="mt-2 text-center text-muted-foreground">
                Enter your credentials to access your vault
              </Text>
            </View>

            {/* Form */}
            <View className="gap-4">
              {/* Server URL */}
              <TextField>
                <TextField.Label>Server URL</TextField.Label>
                <View className="w-full flex-row items-center">
                  <TextField.Input
                    placeholder="https://your-server.com"
                    value={serverUrl}
                    onChangeText={setServerUrl}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    className="flex-1 pl-12 pr-4"
                  />
                  <StyledServer
                    size={20}
                    className="absolute left-3.5 text-muted"
                    pointerEvents="none"
                  />
                </View>
                <TextField.Description>
                  Use your self-hosted Bittery server URL
                </TextField.Description>
              </TextField>

              {/* Email */}
              <TextField>
                <TextField.Label>Email</TextField.Label>
                <View className="w-full flex-row items-center">
                  <TextField.Input
                    placeholder="you@example.com"
                    value={email}
                    onChangeText={setEmail}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                    textContentType="emailAddress"
                    className="flex-1 pl-12 pr-4"
                  />
                  <StyledMail
                    size={20}
                    className="absolute left-3.5 text-muted"
                    pointerEvents="none"
                  />
                </View>
              </TextField>

              {/* Password */}
              <TextField>
                <TextField.Label>Password</TextField.Label>
                <View className="w-full flex-row items-center">
                  <TextField.Input
                    placeholder="Enter your password"
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry={!showPassword}
                    textContentType="password"
                    className="flex-1 pl-12 pr-12"
                  />
                  <StyledLock
                    size={20}
                    className="absolute left-3.5 text-muted"
                    pointerEvents="none"
                  />
                  <Pressable
                    onPress={() => setShowPassword(!showPassword)}
                    className="absolute right-4"
                  >
                    {showPassword ? (
                      <StyledEyeOff size={20} className="text-muted" />
                    ) : (
                      <StyledEye size={20} className="text-muted" />
                    )}
                  </Pressable>
                </View>
              </TextField>

              {/* Secret Key */}
              <TextField>
                <TextField.Label>Secret Key</TextField.Label>
                <TextField.Input
                  placeholder="A3-XXXXXX-XXXXXX-XXXXX"
                  value={secretKey}
                  onChangeText={setSecretKey}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  className="font-mono"
                />
                <TextField.Description>
                  Your Secret Key was provided when you created your account
                </TextField.Description>
              </TextField>

              {/* Biometric Toggle */}
              {biometricAvailable && (
                <FormField
                  isSelected={enableBiometric}
                  onSelectedChange={setEnableBiometric}
                >
                  <View className="flex-1 flex-row items-center gap-3">
                    <StyledFingerprint size={20} className="text-muted" />
                    <View className="flex-1">
                      <FormField.Label>
                        Enable {biometricType || "biometric"} unlock
                      </FormField.Label>
                      <FormField.Description>
                        Quickly unlock with {biometricType || "biometrics"}
                      </FormField.Description>
                    </View>
                  </View>
                  <FormField.Indicator />
                </FormField>
              )}

              {/* Show message if device has hardware but no biometrics enrolled */}
              {biometricDetails.hasHardware && !biometricDetails.isEnrolled && (
                <View className="rounded-lg bg-amber-50 p-4">
                  <View className="flex-row items-start">
                    <Fingerprint size={20} color="#f59e0b" />
                    <View className="ml-3 flex-1">
                      <Text className="font-medium text-amber-800">
                        Biometric Not Set Up
                      </Text>
                      <Text className="text-amber-700 text-sm">
                        Set up {biometricType || "Face ID/Touch ID"} in your
                        device settings to enable quick unlock.
                      </Text>
                    </View>
                  </View>
                </View>
              )}

              {/* Login Button */}
              <Button
                onPress={handleLogin}
                isDisabled={loginMutation.isPending}
                variant="primary"
                size="lg"
                className="mt-4"
              >
                {loginMutation.isPending ? "Signing in..." : "Sign In"}
              </Button>

              {/* Sign Up Link */}
              <Button
                onPress={() => router.push("/(auth)/signup")}
                variant="ghost"
                className="mt-2"
              >
                <Text className="text-muted-foreground">
                  Don't have an account?{" "}
                  <Text className="font-semibold text-primary">Sign up</Text>
                </Text>
              </Button>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
