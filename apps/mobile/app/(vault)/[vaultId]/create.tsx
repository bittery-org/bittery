import { encrypt } from "@bittery/crypto/encryption";
import type { ItemCategory } from "@bittery/shared/types";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
	ArrowLeft,
	CreditCard,
	Eye,
	EyeOff,
	FileText,
	Key,
	Timer,
	User,
} from "lucide-react-native";
import { useState } from "react";
import {
	Alert,
	KeyboardAvoidingView,
	Platform,
	ScrollView,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTRPCClient } from "../../../src/lib/trpc";
import * as storage from "../../../src/services/storage";

const categoryOptions: {
	value: ItemCategory;
	label: string;
	icon: typeof Key;
}[] = [
	{ value: "login", label: "Login", icon: Key },
	{ value: "credit-card", label: "Credit Card", icon: CreditCard },
	{ value: "identity", label: "Identity", icon: User },
	{ value: "secure-note", label: "Secure Note", icon: FileText },
	{ value: "totp", label: "TOTP", icon: Timer },
];

export default function CreateItemScreen() {
	const router = useRouter();
	const { vaultId } = useLocalSearchParams<{ vaultId: string }>();
	const trpcClient = useTRPCClient();

	const [category, setCategory] = useState<ItemCategory>("login");
	const [title, setTitle] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [saving, setSaving] = useState(false);

	// Login fields
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [url, setUrl] = useState("");

	// Credit card fields
	const [cardholderName, setCardholderName] = useState("");
	const [cardNumber, setCardNumber] = useState("");
	const [expiryDate, setExpiryDate] = useState("");
	const [cvv, setCvv] = useState("");

	// Identity fields
	const [firstName, setFirstName] = useState("");
	const [lastName, setLastName] = useState("");
	const [email, setEmail] = useState("");

	// Secure note field
	const [note, setNote] = useState("");

	// TOTP fields
	const [totpSecret, setTotpSecret] = useState("");
	const [totpIssuer, setTotpIssuer] = useState("");

	// Common fields
	const [notes, setNotes] = useState("");

	const handleSave = async () => {
		if (!title.trim()) {
			Alert.alert("Error", "Title is required");
			return;
		}

		setSaving(true);

		try {
			// Get vault key for encryption
			const vaultKey = await storage.getDecryptedVaultKey(vaultId);
			if (!vaultKey) {
				Alert.alert(
					"Error",
					"Unable to access vault key. Please try logging in again.",
				);
				return;
			}

			// Build the data object based on category
			let itemData: Record<string, unknown> = { title };

			switch (category) {
				case "login":
					itemData = {
						...itemData,
						username,
						password,
						url: url || undefined,
						urls: url ? [url] : undefined,
					};
					break;
				case "credit-card":
					itemData = {
						...itemData,
						cardholderName,
						cardNumber,
						expiryDate,
						cvv,
					};
					break;
				case "identity":
					itemData = {
						...itemData,
						firstName,
						lastName,
						email: email || undefined,
					};
					break;
				case "secure-note":
					itemData = {
						...itemData,
						note,
					};
					break;
				case "totp":
					itemData = {
						...itemData,
						totpSecret,
						totpIssuer: totpIssuer || undefined,
					};
					break;
			}

			// Add notes if present
			if (notes.trim()) {
				itemData.notes = notes;
			}

			// Encrypt the data
			const encryptedData = await encrypt(JSON.stringify(itemData), vaultKey);

			// Create the item via API
			await trpcClient.vault.createItem.mutate({
				vaultId,
				category,
				overview: {
					title,
					url: category === "login" ? url : undefined,
					username: category === "login" ? username : undefined,
				},
				encryptedData: encryptedData.ciphertext,
				encryptionIv: encryptedData.iv,
				encryptionAlgorithm: encryptedData.algorithm,
			});

			Alert.alert("Success", "Item created successfully", [
				{
					text: "OK",
					onPress: () => router.back(),
				},
			]);
		} catch (error) {
			console.error("Error creating item:", error);
			Alert.alert(
				"Error",
				error instanceof Error ? error.message : "Failed to create item",
			);
		} finally {
			setSaving(false);
		}
	};

	const renderLoginFields = () => (
		<>
			<View className="mb-4">
				<Text className="mb-2 font-medium text-foreground text-sm">
					Username
				</Text>
				<TextInput
					className="rounded-lg border border-input bg-background px-4 py-3 text-foreground"
					placeholder="Enter username"
					value={username}
					onChangeText={setUsername}
					autoCapitalize="none"
					autoCorrect={false}
				/>
			</View>
			<View className="mb-4">
				<Text className="mb-2 font-medium text-foreground text-sm">
					Password
				</Text>
				<View className="flex-row items-center rounded-lg border border-input bg-background px-4">
					<TextInput
						className="flex-1 py-3 text-foreground"
						placeholder="Enter password"
						value={password}
						onChangeText={setPassword}
						secureTextEntry={!showPassword}
					/>
					<TouchableOpacity onPress={() => setShowPassword(!showPassword)}>
						{showPassword ? (
							<EyeOff size={20} color="#6b7280" />
						) : (
							<Eye size={20} color="#6b7280" />
						)}
					</TouchableOpacity>
				</View>
			</View>
			<View className="mb-4">
				<Text className="mb-2 font-medium text-foreground text-sm">
					Website URL
				</Text>
				<TextInput
					className="rounded-lg border border-input bg-background px-4 py-3 text-foreground"
					placeholder="https://example.com"
					value={url}
					onChangeText={setUrl}
					autoCapitalize="none"
					autoCorrect={false}
					keyboardType="url"
				/>
			</View>
		</>
	);

	const renderCreditCardFields = () => (
		<>
			<View className="mb-4">
				<Text className="mb-2 font-medium text-foreground text-sm">
					Cardholder Name
				</Text>
				<TextInput
					className="rounded-lg border border-input bg-background px-4 py-3 text-foreground"
					placeholder="Name on card"
					value={cardholderName}
					onChangeText={setCardholderName}
					autoCapitalize="words"
				/>
			</View>
			<View className="mb-4">
				<Text className="mb-2 font-medium text-foreground text-sm">
					Card Number
				</Text>
				<TextInput
					className="rounded-lg border border-input bg-background px-4 py-3 font-mono text-foreground"
					placeholder="1234 5678 9012 3456"
					value={cardNumber}
					onChangeText={setCardNumber}
					keyboardType="numeric"
				/>
			</View>
			<View className="mb-4 flex-row">
				<View className="mr-2 flex-1">
					<Text className="mb-2 font-medium text-foreground text-sm">
						Expiry
					</Text>
					<TextInput
						className="rounded-lg border border-input bg-background px-4 py-3 text-foreground"
						placeholder="MM/YY"
						value={expiryDate}
						onChangeText={setExpiryDate}
						keyboardType="numeric"
					/>
				</View>
				<View className="flex-1">
					<Text className="mb-2 font-medium text-foreground text-sm">CVV</Text>
					<TextInput
						className="rounded-lg border border-input bg-background px-4 py-3 text-foreground"
						placeholder="123"
						value={cvv}
						onChangeText={setCvv}
						keyboardType="numeric"
						secureTextEntry
					/>
				</View>
			</View>
		</>
	);

	const renderIdentityFields = () => (
		<>
			<View className="mb-4 flex-row">
				<View className="mr-2 flex-1">
					<Text className="mb-2 font-medium text-foreground text-sm">
						First Name
					</Text>
					<TextInput
						className="rounded-lg border border-input bg-background px-4 py-3 text-foreground"
						placeholder="First name"
						value={firstName}
						onChangeText={setFirstName}
						autoCapitalize="words"
					/>
				</View>
				<View className="flex-1">
					<Text className="mb-2 font-medium text-foreground text-sm">
						Last Name
					</Text>
					<TextInput
						className="rounded-lg border border-input bg-background px-4 py-3 text-foreground"
						placeholder="Last name"
						value={lastName}
						onChangeText={setLastName}
						autoCapitalize="words"
					/>
				</View>
			</View>
			<View className="mb-4">
				<Text className="mb-2 font-medium text-foreground text-sm">Email</Text>
				<TextInput
					className="rounded-lg border border-input bg-background px-4 py-3 text-foreground"
					placeholder="email@example.com"
					value={email}
					onChangeText={setEmail}
					autoCapitalize="none"
					keyboardType="email-address"
				/>
			</View>
		</>
	);

	const renderSecureNoteFields = () => (
		<View className="mb-4">
			<Text className="mb-2 font-medium text-foreground text-sm">Note</Text>
			<TextInput
				className="rounded-lg border border-input bg-background px-4 py-3 text-foreground"
				placeholder="Enter your secure note..."
				value={note}
				onChangeText={setNote}
				multiline
				numberOfLines={6}
				textAlignVertical="top"
				style={{ minHeight: 120 }}
			/>
		</View>
	);

	const renderTotpFields = () => (
		<>
			<View className="mb-4">
				<Text className="mb-2 font-medium text-foreground text-sm">
					Secret Key
				</Text>
				<TextInput
					className="rounded-lg border border-input bg-background px-4 py-3 font-mono text-foreground"
					placeholder="JBSWY3DPEHPK3PXP"
					value={totpSecret}
					onChangeText={setTotpSecret}
					autoCapitalize="characters"
					autoCorrect={false}
				/>
			</View>
			<View className="mb-4">
				<Text className="mb-2 font-medium text-foreground text-sm">
					Issuer (optional)
				</Text>
				<TextInput
					className="rounded-lg border border-input bg-background px-4 py-3 text-foreground"
					placeholder="e.g., Google, GitHub"
					value={totpIssuer}
					onChangeText={setTotpIssuer}
				/>
			</View>
		</>
	);

	return (
		<SafeAreaView className="flex-1 bg-background">
			<KeyboardAvoidingView
				behavior={Platform.OS === "ios" ? "padding" : "height"}
				className="flex-1"
			>
				{/* Header */}
				<View className="flex-row items-center border-border border-b px-4 py-4">
					<TouchableOpacity
						onPress={() => router.back()}
						className="mr-3 rounded-full bg-secondary p-2"
					>
						<ArrowLeft size={20} color="#6b7280" />
					</TouchableOpacity>
					<Text className="flex-1 font-bold text-foreground text-xl">
						New Item
					</Text>
					<TouchableOpacity
						onPress={handleSave}
						disabled={saving}
						className={`rounded-lg px-4 py-2 ${
							saving ? "bg-primary/50" : "bg-primary"
						}`}
					>
						<Text className="font-medium text-primary-foreground">
							{saving ? "Saving..." : "Save"}
						</Text>
					</TouchableOpacity>
				</View>

				<ScrollView className="flex-1 px-4" keyboardShouldPersistTaps="handled">
					{/* Category Selector */}
					<View className="my-4">
						<Text className="mb-2 font-medium text-foreground text-sm">
							Category
						</Text>
						<ScrollView horizontal showsHorizontalScrollIndicator={false}>
							{categoryOptions.map((option) => {
								const Icon = option.icon;
								const isSelected = category === option.value;
								return (
									<TouchableOpacity
										key={option.value}
										onPress={() => setCategory(option.value)}
										className={`mr-3 flex-row items-center rounded-lg px-4 py-3 ${
											isSelected ? "bg-primary" : "bg-secondary"
										}`}
									>
										<Icon size={18} color={isSelected ? "#fff" : "#6b7280"} />
										<Text
											className={`ml-2 font-medium ${
												isSelected
													? "text-primary-foreground"
													: "text-foreground"
											}`}
										>
											{option.label}
										</Text>
									</TouchableOpacity>
								);
							})}
						</ScrollView>
					</View>

					{/* Title */}
					<View className="mb-4">
						<Text className="mb-2 font-medium text-foreground text-sm">
							Title *
						</Text>
						<TextInput
							className="rounded-lg border border-input bg-background px-4 py-3 text-foreground"
							placeholder="Enter title"
							value={title}
							onChangeText={setTitle}
						/>
					</View>

					{/* Category-specific fields */}
					{category === "login" && renderLoginFields()}
					{category === "credit-card" && renderCreditCardFields()}
					{category === "identity" && renderIdentityFields()}
					{category === "secure-note" && renderSecureNoteFields()}
					{category === "totp" && renderTotpFields()}

					{/* Notes (for non-secure-note items) */}
					{category !== "secure-note" && (
						<View className="mb-4">
							<Text className="mb-2 font-medium text-foreground text-sm">
								Notes (optional)
							</Text>
							<TextInput
								className="rounded-lg border border-input bg-background px-4 py-3 text-foreground"
								placeholder="Add any additional notes..."
								value={notes}
								onChangeText={setNotes}
								multiline
								numberOfLines={3}
								textAlignVertical="top"
								style={{ minHeight: 80 }}
							/>
						</View>
					)}

					{/* Bottom padding */}
					<View className="h-8" />
				</ScrollView>
			</KeyboardAvoidingView>
		</SafeAreaView>
	);
}
