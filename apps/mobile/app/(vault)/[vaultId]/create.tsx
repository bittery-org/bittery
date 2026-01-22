import { encrypt } from "@bittery/crypto/encryption";
import {
	type CardBrand,
	detectCardBrand,
	formatCardNumber,
	getCardBrandDisplayName,
} from "@bittery/shared/credit-card";
import {
	isValidBase32,
	parseOtpAuthUri,
	type ParsedOtpAuthUri,
} from "@bittery/shared/totp";
import type {
	ItemCategory,
	TotpAlgorithm,
	TotpDigits,
} from "@bittery/shared/types";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
	ArrowLeft,
	Camera,
	ChevronDown,
	ChevronRight,
	ClipboardPaste,
	CreditCard,
	Eye,
	EyeOff,
	FileText,
	Key,
	Sparkles,
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
import { PasswordGenerator } from "../../../src/components/password-generator";
import { QrCodeScanner } from "../../../src/components/qr-code-scanner";
import { TotpDisplay } from "../../../src/components/totp-display";

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
	const [showPasswordGenerator, setShowPasswordGenerator] = useState(false);

	// Login fields
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [url, setUrl] = useState("");

	// Credit card fields
	const [cardholderName, setCardholderName] = useState("");
	const [cardNumber, setCardNumber] = useState("");
	const [expiryDate, setExpiryDate] = useState("");
	const [cvv, setCvv] = useState("");
	const [billingAddress, setBillingAddress] = useState("");
	const [detectedCardBrand, setDetectedCardBrand] = useState<CardBrand | "">(
		"",
	);
	const [showCvv, setShowCvv] = useState(false);

	// Identity fields
	const [firstName, setFirstName] = useState("");
	const [lastName, setLastName] = useState("");
	const [email, setEmail] = useState("");

	// Secure note field
	const [note, setNote] = useState("");

	// TOTP fields
	const [totpSecret, setTotpSecret] = useState("");
	const [totpIssuer, setTotpIssuer] = useState("");
	const [totpAccountName, setTotpAccountName] = useState("");
	const [totpAlgorithm, setTotpAlgorithm] = useState<TotpAlgorithm>("SHA1");
	const [totpDigits, setTotpDigits] = useState<TotpDigits>(6);
	const [totpPeriod, setTotpPeriod] = useState(30);
	const [showTotpAdvanced, setShowTotpAdvanced] = useState(false);
	const [showQrScanner, setShowQrScanner] = useState(false);

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
						billingAddress: billingAddress || undefined,
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
						totpAccountName: totpAccountName || undefined,
						totpAlgorithm,
						totpDigits,
						totpPeriod,
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
				<View className="flex-row items-center gap-2">
					<View className="flex-1 flex-row items-center rounded-lg border border-input bg-background px-4">
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
					<TouchableOpacity
						onPress={() => setShowPasswordGenerator(true)}
						className="rounded-lg bg-primary p-3"
					>
						<Sparkles size={20} color="#fff" />
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

	// Card number change handler with brand detection and formatting
	const handleCardNumberChange = (value: string) => {
		// Remove all non-digits
		const cleaned = value.replace(/\D/g, "");

		// Detect brand when we have at least 4 digits
		if (cleaned.length >= 4) {
			const brand = detectCardBrand(cleaned);
			setDetectedCardBrand(brand);
		} else {
			setDetectedCardBrand("");
		}

		setCardNumber(cleaned);
	};

	// Expiry date auto-formatting
	const handleExpiryChange = (value: string) => {
		let cleaned = value.replace(/\D/g, "");
		if (cleaned.length >= 2) {
			cleaned = `${cleaned.slice(0, 2)}/${cleaned.slice(2, 4)}`;
		}
		setExpiryDate(cleaned);
	};

	// CVV change handler - only allow digits
	const handleCvvChange = (value: string) => {
		const cleaned = value.replace(/\D/g, "");
		setCvv(cleaned);
	};

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
				<View className="mb-2 flex-row items-center justify-between">
					<Text className="font-medium text-foreground text-sm">
						Card Number
					</Text>
					{detectedCardBrand && detectedCardBrand !== "unknown" && (
						<Text className="text-muted-foreground text-xs">
							{getCardBrandDisplayName(detectedCardBrand)}
						</Text>
					)}
				</View>
				<TextInput
					className="rounded-lg border border-input bg-background px-4 py-3 font-mono text-foreground"
					placeholder="1234 5678 9012 3456"
					value={formatCardNumber(cardNumber, detectedCardBrand || undefined)}
					onChangeText={handleCardNumberChange}
					keyboardType="numeric"
					maxLength={23}
				/>
			</View>
			<View className="mb-4 flex-row">
				<View className="mr-2 flex-1">
					<Text className="mb-2 font-medium text-foreground text-sm">
						Expiry
					</Text>
					<TextInput
						className="rounded-lg border border-input bg-background px-4 py-3 font-mono text-foreground"
						placeholder="MM/YY"
						value={expiryDate}
						onChangeText={handleExpiryChange}
						keyboardType="numeric"
						maxLength={5}
					/>
				</View>
				<View className="flex-1">
					<Text className="mb-2 font-medium text-foreground text-sm">CVV</Text>
					<View className="flex-row items-center rounded-lg border border-input bg-background px-4">
						<TextInput
							className="flex-1 py-3 font-mono text-foreground"
							placeholder="123"
							value={cvv}
							onChangeText={handleCvvChange}
							keyboardType="numeric"
							secureTextEntry={!showCvv}
							maxLength={detectedCardBrand === "amex" ? 4 : 3}
						/>
						<TouchableOpacity onPress={() => setShowCvv(!showCvv)}>
							{showCvv ? (
								<EyeOff size={20} color="#6b7280" />
							) : (
								<Eye size={20} color="#6b7280" />
							)}
						</TouchableOpacity>
					</View>
				</View>
			</View>
			<View className="mb-4">
				<Text className="mb-2 font-medium text-foreground text-sm">
					Billing Address
				</Text>
				<TextInput
					className="rounded-lg border border-input bg-background px-4 py-3 text-foreground"
					placeholder="123 Main St, City, State ZIP"
					value={billingAddress}
					onChangeText={setBillingAddress}
					multiline
					numberOfLines={2}
					textAlignVertical="top"
					style={{ minHeight: 60 }}
				/>
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

	// Handle QR code scan result
	const handleQrScanSuccess = (data: ParsedOtpAuthUri) => {
		setTotpSecret(data.secret);
		if (data.issuer) setTotpIssuer(data.issuer);
		if (data.accountName) setTotpAccountName(data.accountName);
		if (data.algorithm) setTotpAlgorithm(data.algorithm);
		if (data.digits) setTotpDigits(data.digits);
		if (data.period) setTotpPeriod(data.period);

		// Auto-fill title if empty
		if (!title && (data.issuer || data.accountName)) {
			setTitle(data.issuer || data.accountName || "TOTP");
		}

		Alert.alert("Success", "TOTP data imported from QR code");
	};

	// Handle paste from clipboard
	const handlePasteTotp = async () => {
		try {
			const text = await Clipboard.getStringAsync();
			if (!text) {
				Alert.alert("Empty Clipboard", "No text found in clipboard");
				return;
			}

			// Check if it's an otpauth:// URI
			if (text.startsWith("otpauth://")) {
				try {
					const parsed = parseOtpAuthUri(text);
					if (isValidBase32(parsed.secret)) {
						handleQrScanSuccess(parsed);
						return;
					}
				} catch {
					// Not a valid URI, try as raw secret
				}
			}

			// Try as raw base32 secret
			const cleanedSecret = text.replace(/\s/g, "").toUpperCase();
			if (isValidBase32(cleanedSecret)) {
				setTotpSecret(cleanedSecret);
				Alert.alert("Success", "Secret key pasted from clipboard");
			} else {
				Alert.alert(
					"Invalid Format",
					"The clipboard content is not a valid TOTP secret or otpauth:// URI",
				);
			}
		} catch (error) {
			console.error("Error pasting from clipboard:", error);
			Alert.alert("Error", "Failed to read from clipboard");
		}
	};

	const renderTotpFields = () => (
		<>
			{/* Quick Import Buttons */}
			<View className="mb-4 flex-row gap-2">
				<TouchableOpacity
					onPress={() => setShowQrScanner(true)}
					className="flex-1 flex-row items-center justify-center rounded-lg border border-primary bg-primary/10 py-3"
				>
					<Camera size={18} color="#6366f1" />
					<Text className="ml-2 font-medium text-primary">Scan QR Code</Text>
				</TouchableOpacity>
				<TouchableOpacity
					onPress={handlePasteTotp}
					className="flex-1 flex-row items-center justify-center rounded-lg border border-border bg-secondary py-3"
				>
					<ClipboardPaste size={18} color="#6b7280" />
					<Text className="ml-2 font-medium text-foreground">Paste</Text>
				</TouchableOpacity>
			</View>

			{/* Secret Key Input */}
			<View className="mb-4">
				<Text className="mb-2 font-medium text-foreground text-sm">
					Secret Key *
				</Text>
				<TextInput
					className="rounded-lg border border-input bg-background px-4 py-3 font-mono text-foreground"
					placeholder="JBSWY3DPEHPK3PXP"
					value={totpSecret}
					onChangeText={setTotpSecret}
					autoCapitalize="characters"
					autoCorrect={false}
				/>
				{totpSecret && !isValidBase32(totpSecret) && (
					<Text className="mt-1 text-destructive text-xs">
						Invalid base32 format. Please check the secret key.
					</Text>
				)}
			</View>

			{/* Live Preview */}
			{totpSecret && isValidBase32(totpSecret) && (
				<View className="mb-4">
					<Text className="mb-2 font-medium text-foreground text-sm">
						Preview
					</Text>
					<TotpDisplay
						totpSecret={totpSecret}
						totpAlgorithm={totpAlgorithm}
						totpDigits={totpDigits}
						totpPeriod={totpPeriod}
						compact
					/>
				</View>
			)}

			{/* Issuer & Account */}
			<View className="mb-4 flex-row gap-2">
				<View className="flex-1">
					<Text className="mb-2 font-medium text-foreground text-sm">
						Service
					</Text>
					<TextInput
						className="rounded-lg border border-input bg-background px-4 py-3 text-foreground"
						placeholder="Google, GitHub..."
						value={totpIssuer}
						onChangeText={setTotpIssuer}
					/>
				</View>
				<View className="flex-1">
					<Text className="mb-2 font-medium text-foreground text-sm">
						Account
					</Text>
					<TextInput
						className="rounded-lg border border-input bg-background px-4 py-3 text-foreground"
						placeholder="your@email.com"
						value={totpAccountName}
						onChangeText={setTotpAccountName}
					/>
				</View>
			</View>

			{/* Advanced Settings */}
			<TouchableOpacity
				onPress={() => setShowTotpAdvanced(!showTotpAdvanced)}
				className="mb-4 flex-row items-center justify-between rounded-lg border border-border p-3"
			>
				<Text className="font-medium text-foreground text-sm">
					Advanced Settings
				</Text>
				{showTotpAdvanced ? (
					<ChevronDown size={16} color="#6b7280" />
				) : (
					<ChevronRight size={16} color="#6b7280" />
				)}
			</TouchableOpacity>
			{showTotpAdvanced && (
				<View className="mb-4 rounded-lg bg-secondary/30 p-3">
					<View className="mb-4 flex-row gap-2">
						<View className="flex-1">
							<Text className="mb-1 text-muted-foreground text-xs">Digits</Text>
							<View className="flex-row rounded-lg border border-input bg-background">
								{[6, 7, 8].map((d) => (
									<TouchableOpacity
										key={d}
										onPress={() => setTotpDigits(d as TotpDigits)}
										className={`flex-1 items-center py-2 ${totpDigits === d ? "bg-primary" : ""}`}
									>
										<Text
											className={`text-sm ${totpDigits === d ? "text-primary-foreground" : "text-foreground"}`}
										>
											{d}
										</Text>
									</TouchableOpacity>
								))}
							</View>
						</View>
						<View className="flex-1">
							<Text className="mb-1 text-muted-foreground text-xs">
								Period (sec)
							</Text>
							<TextInput
								className="rounded-lg border border-input bg-background px-4 py-2 text-foreground"
								value={totpPeriod.toString()}
								onChangeText={(v) =>
									setTotpPeriod(Number.parseInt(v, 10) || 30)
								}
								keyboardType="numeric"
							/>
						</View>
					</View>
					<View>
						<Text className="mb-1 text-muted-foreground text-xs">
							Algorithm
						</Text>
						<View className="flex-row rounded-lg border border-input bg-background">
							{(["SHA1", "SHA256", "SHA512"] as TotpAlgorithm[]).map((algo) => (
								<TouchableOpacity
									key={algo}
									onPress={() => setTotpAlgorithm(algo)}
									className={`flex-1 items-center py-2 ${totpAlgorithm === algo ? "bg-primary" : ""}`}
								>
									<Text
										className={`text-xs ${totpAlgorithm === algo ? "text-primary-foreground" : "text-foreground"}`}
									>
										{algo}
									</Text>
								</TouchableOpacity>
							))}
						</View>
					</View>
				</View>
			)}
		</>
	);

	return (
		<SafeAreaView className="flex-1 bg-background">
			<PasswordGenerator
				visible={showPasswordGenerator}
				onClose={() => setShowPasswordGenerator(false)}
				onPasswordGenerated={(generatedPassword) => {
					setPassword(generatedPassword);
					setShowPasswordGenerator(false);
				}}
			/>
			<QrCodeScanner
				visible={showQrScanner}
				onClose={() => setShowQrScanner(false)}
				onScanSuccess={handleQrScanSuccess}
			/>
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
