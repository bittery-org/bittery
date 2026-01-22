import { encrypt } from "@bittery/crypto/encryption";
import {
	type CardBrand,
	detectCardBrand,
	formatCardNumber,
	getCardBrandDisplayName,
} from "@bittery/shared/credit-card";
import type { Address, PhoneNumber } from "@bittery/shared/identity";
import {
	isValidBase32,
	parseOtpAuthUri,
	type ParsedOtpAuthUri,
} from "@bittery/shared/totp";
import type {
	CustomField,
	ItemCategory,
	TotpAlgorithm,
	TotpDigits,
} from "@bittery/shared/types";
import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
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
	Plus,
	Sparkles,
	Timer,
	Trash2,
	User,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import {
	ActivityIndicator,
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
import { PasswordGenerator } from "../../../../src/components/password-generator";
import { QrCodeScanner } from "../../../../src/components/qr-code-scanner";
import { TotpDisplay } from "../../../../src/components/totp-display";

import { useDecryptedItems } from "../../../../src/hooks/use-decrypted-items";
import { useTRPCClient } from "../../../../src/lib/trpc";
import * as storage from "../../../../src/services/storage";

// Helper function to generate unique IDs
const generateId = () => Crypto.randomUUID();

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

export default function EditItemScreen() {
	const router = useRouter();
	const { vaultId, itemId } = useLocalSearchParams<{
		vaultId: string;
		itemId: string;
	}>();
	const trpcClient = useTRPCClient();

	const { items, isLoading, refetch } = useDecryptedItems(vaultId);
	const item = items.find((i) => i.id === itemId);

	const [initialized, setInitialized] = useState(false);
	const [saving, setSaving] = useState(false);
	const [showPassword, setShowPassword] = useState(false);
	const [showCvv, setShowCvv] = useState(false);
	const [showPasswordGenerator, setShowPasswordGenerator] = useState(false);

	// Common fields
	const [title, setTitle] = useState("");
	const [notes, setNotes] = useState("");
	const [tags, setTags] = useState<string[]>([]);
	const [newTag, setNewTag] = useState("");
	const [customFields, setCustomFields] = useState<CustomField[]>([]);

	// Login fields
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [url, setUrl] = useState("");
	const [additionalUrls, setAdditionalUrls] = useState<string[]>([]);

	// Login TOTP fields
	const [totpSecret, setTotpSecret] = useState("");
	const [totpIssuer, setTotpIssuer] = useState("");
	const [totpAccountName, setTotpAccountName] = useState("");
	const [totpAlgorithm, setTotpAlgorithm] = useState<TotpAlgorithm>("SHA1");
	const [totpDigits, setTotpDigits] = useState<TotpDigits>(6);
	const [totpPeriod, setTotpPeriod] = useState(30);
	const [showTotpSection, setShowTotpSection] = useState(false);
	const [showTotpAdvanced, setShowTotpAdvanced] = useState(false);
	const [showQrScanner, setShowQrScanner] = useState(false);

	// Credit card fields
	const [cardholderName, setCardholderName] = useState("");
	const [cardNumber, setCardNumber] = useState("");
	const [expiryDate, setExpiryDate] = useState("");
	const [cvv, setCvv] = useState("");
	const [billingAddress, setBillingAddress] = useState("");
	const [detectedCardBrand, setDetectedCardBrand] = useState<CardBrand | "">(
		"",
	);

	// Identity fields
	const [firstName, setFirstName] = useState("");
	const [middleName, setMiddleName] = useState("");
	const [lastName, setLastName] = useState("");
	const [email, setEmail] = useState("");
	const [dateOfBirth, setDateOfBirth] = useState("");
	const [ssn, setSsn] = useState("");
	const [passportNumber, setPassportNumber] = useState("");
	const [driversLicense, setDriversLicense] = useState("");
	const [addresses, setAddresses] = useState<Address[]>([]);
	const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumber[]>([]);

	// Secure note field
	const [note, setNote] = useState("");

	// Initialize form with item data
	useEffect(() => {
		if (item && !initialized) {
			setTitle(item.title || "");
			setNotes(item.notes || "");
			setTags(item.tags || []);
			setCustomFields(item.customFields || []);

			// Login fields
			if (item.category === "login") {
				setUsername(item.username || "");
				setPassword(item.password || "");
				setUrl(item.url || "");
				setAdditionalUrls(item.urls?.slice(1) || []);
				// TOTP fields for login
				if (item.totpSecret) {
					setShowTotpSection(true);
					setTotpSecret(item.totpSecret || "");
					setTotpIssuer(item.totpIssuer || "");
					setTotpAccountName(item.totpAccountName || "");
					setTotpAlgorithm(item.totpAlgorithm || "SHA1");
					setTotpDigits(item.totpDigits || 6);
					setTotpPeriod(item.totpPeriod || 30);
				}
			}

			// Credit card fields
			if (item.category === "credit-card") {
				setCardholderName(item.cardholderName || "");
				const cardNum = item.cardNumber || "";
				setCardNumber(cardNum);
				setExpiryDate(item.expiryDate || "");
				setCvv(item.cvv || "");
				setBillingAddress(item.billingAddress || "");
				// Detect card brand for existing card number
				if (cardNum.length >= 4) {
					setDetectedCardBrand(detectCardBrand(cardNum));
				}
			}

			// Identity fields
			if (item.category === "identity") {
				setFirstName(item.firstName || "");
				setMiddleName(item.middleName || "");
				setLastName(item.lastName || "");
				setEmail(item.email || "");
				setDateOfBirth(item.dateOfBirth || "");
				setSsn(item.ssn || "");
				setPassportNumber(item.passportNumber || "");
				setDriversLicense(item.driversLicense || "");
				setAddresses(item.addresses || []);
				setPhoneNumbers(item.phoneNumbers || []);
			}

			// Secure note
			if (item.category === "secure-note") {
				setNote(item.note || item.notes || "");
			}

			// TOTP item
			if (item.category === "totp") {
				setTotpSecret(item.totpSecret || "");
				setTotpIssuer(item.totpIssuer || "");
				setTotpAccountName(item.totpAccountName || "");
				setTotpAlgorithm(item.totpAlgorithm || "SHA1");
				setTotpDigits(item.totpDigits || 6);
				setTotpPeriod(item.totpPeriod || 30);
			}

			setInitialized(true);
		}
	}, [item, initialized]);

	const handleSave = async () => {
		if (!item) return;
		if (!title.trim()) {
			Alert.alert("Error", "Title is required");
			return;
		}

		setSaving(true);

		try {
			const vaultKey = await storage.getDecryptedVaultKey(vaultId);
			if (!vaultKey) {
				Alert.alert(
					"Error",
					"Unable to access vault key. Please try logging in again.",
				);
				return;
			}

			// Build the data object based on category
			let itemData: Record<string, unknown> = {
				title,
				notes: notes || undefined,
				tags: tags.length > 0 ? tags : undefined,
				customFields: customFields.length > 0 ? customFields : undefined,
			};

			switch (item.category) {
				case "login":
					itemData = {
						...itemData,
						username,
						password,
						url: url || undefined,
						urls: url ? [url, ...additionalUrls.filter(Boolean)] : undefined,
						// TOTP fields
						totpSecret: showTotpSection && totpSecret ? totpSecret : undefined,
						totpIssuer: showTotpSection && totpIssuer ? totpIssuer : undefined,
						totpAccountName:
							showTotpSection && totpAccountName ? totpAccountName : undefined,
						totpAlgorithm:
							showTotpSection && totpSecret ? totpAlgorithm : undefined,
						totpDigits: showTotpSection && totpSecret ? totpDigits : undefined,
						totpPeriod: showTotpSection && totpSecret ? totpPeriod : undefined,
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
						firstName: firstName || undefined,
						middleName: middleName || undefined,
						lastName: lastName || undefined,
						email: email || undefined,
						dateOfBirth: dateOfBirth || undefined,
						ssn: ssn || undefined,
						passportNumber: passportNumber || undefined,
						driversLicense: driversLicense || undefined,
						addresses: addresses.length > 0 ? addresses : undefined,
						phoneNumbers: phoneNumbers.length > 0 ? phoneNumbers : undefined,
					};
					break;
				case "secure-note":
					itemData = {
						...itemData,
						note,
						notes: undefined, // Secure notes use 'note' field
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

			// Encrypt the data
			const encryptedData = await encrypt(JSON.stringify(itemData), vaultKey);

			// Update the item via API
			await trpcClient.vault.updateItem.mutate({
				itemId,
				encryptedData: encryptedData.ciphertext,
				encryptionIv: encryptedData.iv,
			});

			// Refetch the items to update the cache
			await refetch();

			Alert.alert("Success", "Item updated successfully", [
				{
					text: "OK",
					onPress: () => router.back(),
				},
			]);
		} catch (error) {
			console.error("Error updating item:", error);
			Alert.alert(
				"Error",
				error instanceof Error ? error.message : "Failed to update item",
			);
		} finally {
			setSaving(false);
		}
	};

	// Custom field management
	const addCustomField = () => {
		setCustomFields([
			...customFields,
			{ id: generateId(), label: "", value: "", type: "text" },
		]);
	};

	const updateCustomField = (id: string, field: Partial<CustomField>) => {
		setCustomFields(
			customFields.map((cf) => (cf.id === id ? { ...cf, ...field } : cf)),
		);
	};

	const removeCustomField = (id: string) => {
		setCustomFields(customFields.filter((cf) => cf.id !== id));
	};

	// Tag management
	const addTag = () => {
		const trimmedTag = newTag.trim();
		if (trimmedTag && !tags.includes(trimmedTag)) {
			setTags([...tags, trimmedTag]);
			setNewTag("");
		}
	};

	const removeTag = (tag: string) => {
		setTags(tags.filter((t) => t !== tag));
	};

	// Address management
	const addAddress = () => {
		setAddresses([
			...addresses,
			{
				id: generateId(),
				street: "",
				city: "",
				state: "",
				zip: "",
				country: "",
			},
		]);
	};

	const updateAddress = (id: string, field: Partial<Address>) => {
		setAddresses(
			addresses.map((addr) => (addr.id === id ? { ...addr, ...field } : addr)),
		);
	};

	const removeAddress = (id: string) => {
		setAddresses(addresses.filter((addr) => addr.id !== id));
	};

	// Phone number management
	const addPhoneNumber = () => {
		setPhoneNumbers([
			...phoneNumbers,
			{ id: generateId(), label: "Mobile", number: "" },
		]);
	};

	const updatePhoneNumber = (id: string, field: Partial<PhoneNumber>) => {
		setPhoneNumbers(
			phoneNumbers.map((phone) =>
				phone.id === id ? { ...phone, ...field } : phone,
			),
		);
	};

	const removePhoneNumber = (id: string) => {
		setPhoneNumbers(phoneNumbers.filter((phone) => phone.id !== id));
	};

	// Additional URL management
	const addAdditionalUrl = () => {
		setAdditionalUrls([...additionalUrls, ""]);
	};

	const updateAdditionalUrl = (index: number, value: string) => {
		const updated = [...additionalUrls];
		updated[index] = value;
		setAdditionalUrls(updated);
	};

	const removeAdditionalUrl = (index: number) => {
		setAdditionalUrls(additionalUrls.filter((_, i) => i !== index));
	};

	// Expiry date auto-formatting
	const handleExpiryChange = (value: string) => {
		let cleaned = value.replace(/\D/g, "");
		if (cleaned.length >= 2) {
			cleaned = `${cleaned.slice(0, 2)}/${cleaned.slice(2, 4)}`;
		}
		setExpiryDate(cleaned);
	};

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

	// CVV change handler - only allow digits
	const handleCvvChange = (value: string) => {
		const cleaned = value.replace(/\D/g, "");
		setCvv(cleaned);
	};

	// Render loading state
	if (isLoading) {
		return (
			<SafeAreaView className="flex-1 items-center justify-center bg-background">
				<ActivityIndicator size="large" color="#000" />
			</SafeAreaView>
		);
	}

	// Render error state
	if (!item) {
		return (
			<SafeAreaView className="flex-1 items-center justify-center bg-background">
				<Text className="text-foreground">Item not found</Text>
				<TouchableOpacity
					onPress={() => router.back()}
					className="mt-4 rounded-lg bg-primary px-4 py-2"
				>
					<Text className="text-primary-foreground">Go Back</Text>
				</TouchableOpacity>
			</SafeAreaView>
		);
	}

	const CategoryIcon = categoryOptions.find(
		(c) => c.value === item.category,
	)?.icon;

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

			{/* Additional URLs */}
			<View className="mb-4">
				<View className="mb-2 flex-row items-center justify-between">
					<Text className="font-medium text-foreground text-sm">
						Additional Websites
					</Text>
					<TouchableOpacity
						onPress={addAdditionalUrl}
						className="flex-row items-center rounded-lg bg-secondary px-3 py-1"
					>
						<Plus size={14} color="#6b7280" />
						<Text className="ml-1 text-foreground text-sm">Add</Text>
					</TouchableOpacity>
				</View>
				{additionalUrls.map((additionalUrl, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: URLs don't have unique IDs
					<View
						key={`url-${index}`}
						className="mb-2 flex-row items-center gap-2"
					>
						<TextInput
							className="flex-1 rounded-lg border border-input bg-background px-4 py-3 text-foreground"
							placeholder="https://example.com"
							value={additionalUrl}
							onChangeText={(value) => updateAdditionalUrl(index, value)}
							autoCapitalize="none"
							keyboardType="url"
						/>
						<TouchableOpacity
							onPress={() => removeAdditionalUrl(index)}
							className="rounded-lg bg-destructive/10 p-3"
						>
							<Trash2 size={18} color="#ef4444" />
						</TouchableOpacity>
					</View>
				))}
			</View>

			{/* TOTP Section for Login Items */}
			<View className="mb-4">
				<View className="mb-2 flex-row items-center justify-between">
					<Text className="font-medium text-foreground text-sm">
						Two-Factor Authentication
					</Text>
					{!showTotpSection && (
						<TouchableOpacity
							onPress={() => setShowTotpSection(true)}
							className="flex-row items-center rounded-lg bg-secondary px-3 py-1"
						>
							<Plus size={14} color="#6b7280" />
							<Text className="ml-1 text-foreground text-sm">Add TOTP</Text>
						</TouchableOpacity>
					)}
				</View>
				{showTotpSection && (
					<View className="rounded-lg border border-border p-4">
						{/* Quick Import Buttons */}
						<View className="mb-4 flex-row gap-2">
							<TouchableOpacity
								onPress={() => setShowQrScanner(true)}
								className="flex-1 flex-row items-center justify-center rounded-lg border border-primary bg-primary/10 py-2"
							>
								<Camera size={16} color="#6366f1" />
								<Text className="ml-2 font-medium text-primary text-sm">Scan QR</Text>
							</TouchableOpacity>
							<TouchableOpacity
								onPress={handlePasteTotp}
								className="flex-1 flex-row items-center justify-center rounded-lg border border-border bg-secondary py-2"
							>
								<ClipboardPaste size={16} color="#6b7280" />
								<Text className="ml-2 font-medium text-foreground text-sm">Paste</Text>
							</TouchableOpacity>
						</View>

						{/* Secret Key Input */}
						<View className="mb-4">
							<Text className="mb-2 font-medium text-foreground text-sm">
								Secret Key *
							</Text>
							<TextInput
								className="rounded-lg border border-input bg-background px-4 py-3 font-mono text-foreground"
								placeholder="XXXX XXXX XXXX XXXX"
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
									placeholder="Google, GitHub, etc."
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

						{/* Advanced TOTP Settings */}
						<TouchableOpacity
							onPress={() => setShowTotpAdvanced(!showTotpAdvanced)}
							className="mb-2 flex-row items-center justify-between rounded-lg border border-border p-3"
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
								<View className="mb-2 flex-row gap-2">
									<View className="flex-1">
										<Text className="mb-1 text-muted-foreground text-xs">
											Digits
										</Text>
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
										{(["SHA1", "SHA256", "SHA512"] as TotpAlgorithm[]).map(
											(algo) => (
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
											),
										)}
									</View>
								</View>
							</View>
						)}

						<TouchableOpacity
							onPress={() => {
								setShowTotpSection(false);
								setTotpSecret("");
								setTotpIssuer("");
								setTotpAccountName("");
							}}
							className="flex-row items-center justify-center rounded-lg bg-destructive/10 py-2"
						>
							<Trash2 size={14} color="#ef4444" />
							<Text className="ml-2 text-destructive text-sm">Remove TOTP</Text>
						</TouchableOpacity>
					</View>
				)}
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
			{/* Personal Information */}
			<View className="mb-4 rounded-lg border border-border p-4">
				<Text className="mb-3 font-semibold text-foreground">
					Personal Information
				</Text>
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
					<Text className="mb-2 font-medium text-foreground text-sm">
						Middle Name
					</Text>
					<TextInput
						className="rounded-lg border border-input bg-background px-4 py-3 text-foreground"
						placeholder="Middle name"
						value={middleName}
						onChangeText={setMiddleName}
						autoCapitalize="words"
					/>
				</View>
				<View className="mb-4">
					<Text className="mb-2 font-medium text-foreground text-sm">
						Email
					</Text>
					<TextInput
						className="rounded-lg border border-input bg-background px-4 py-3 text-foreground"
						placeholder="email@example.com"
						value={email}
						onChangeText={setEmail}
						autoCapitalize="none"
						keyboardType="email-address"
					/>
				</View>
				<View className="mb-2">
					<Text className="mb-2 font-medium text-foreground text-sm">
						Date of Birth
					</Text>
					<TextInput
						className="rounded-lg border border-input bg-background px-4 py-3 text-foreground"
						placeholder="YYYY-MM-DD"
						value={dateOfBirth}
						onChangeText={setDateOfBirth}
					/>
				</View>
			</View>

			{/* Phone Numbers */}
			<View className="mb-4">
				<View className="mb-2 flex-row items-center justify-between">
					<Text className="font-medium text-foreground text-sm">
						Phone Numbers
					</Text>
					<TouchableOpacity
						onPress={addPhoneNumber}
						className="flex-row items-center rounded-lg bg-secondary px-3 py-1"
					>
						<Plus size={14} color="#6b7280" />
						<Text className="ml-1 text-foreground text-sm">Add</Text>
					</TouchableOpacity>
				</View>
				{phoneNumbers.map((phone) => (
					<View
						key={phone.id}
						className="mb-2 rounded-lg border border-border p-3"
					>
						<View className="flex-row items-center gap-2">
							<View className="rounded-lg border border-input bg-background px-3 py-2">
								<TouchableOpacity
									onPress={() => {
										const labels = ["Mobile", "Home", "Work", "Other"];
										const currentIndex = labels.indexOf(phone.label);
										const nextLabel =
											labels[(currentIndex + 1) % labels.length];
										updatePhoneNumber(phone.id, { label: nextLabel });
									}}
								>
									<Text className="text-foreground text-sm">{phone.label}</Text>
								</TouchableOpacity>
							</View>
							<TextInput
								className="flex-1 rounded-lg border border-input bg-background px-4 py-2 text-foreground"
								placeholder="(555) 123-4567"
								value={phone.number}
								onChangeText={(value) =>
									updatePhoneNumber(phone.id, { number: value })
								}
								keyboardType="phone-pad"
							/>
							<TouchableOpacity
								onPress={() => removePhoneNumber(phone.id)}
								className="rounded-lg bg-destructive/10 p-2"
							>
								<Trash2 size={16} color="#ef4444" />
							</TouchableOpacity>
						</View>
					</View>
				))}
			</View>

			{/* Addresses */}
			<View className="mb-4">
				<View className="mb-2 flex-row items-center justify-between">
					<Text className="font-medium text-foreground text-sm">Addresses</Text>
					<TouchableOpacity
						onPress={addAddress}
						className="flex-row items-center rounded-lg bg-secondary px-3 py-1"
					>
						<Plus size={14} color="#6b7280" />
						<Text className="ml-1 text-foreground text-sm">Add</Text>
					</TouchableOpacity>
				</View>
				{addresses.map((address) => (
					<View
						key={address.id}
						className="mb-2 rounded-lg border border-border p-3"
					>
						<View className="mb-2 flex-row items-center justify-between">
							<Text className="font-medium text-muted-foreground text-xs">
								Address
							</Text>
							<TouchableOpacity
								onPress={() => removeAddress(address.id)}
								className="rounded-lg bg-destructive/10 p-1"
							>
								<Trash2 size={14} color="#ef4444" />
							</TouchableOpacity>
						</View>
						<TextInput
							className="mb-2 rounded-lg border border-input bg-background px-4 py-2 text-foreground"
							placeholder="Street Address"
							value={address.street}
							onChangeText={(value) =>
								updateAddress(address.id, { street: value })
							}
						/>
						<View className="mb-2 flex-row gap-2">
							<TextInput
								className="flex-1 rounded-lg border border-input bg-background px-4 py-2 text-foreground"
								placeholder="City"
								value={address.city}
								onChangeText={(value) =>
									updateAddress(address.id, { city: value })
								}
							/>
							<TextInput
								className="flex-1 rounded-lg border border-input bg-background px-4 py-2 text-foreground"
								placeholder="State"
								value={address.state}
								onChangeText={(value) =>
									updateAddress(address.id, { state: value })
								}
							/>
						</View>
						<View className="flex-row gap-2">
							<TextInput
								className="flex-1 rounded-lg border border-input bg-background px-4 py-2 text-foreground"
								placeholder="ZIP Code"
								value={address.zip}
								onChangeText={(value) =>
									updateAddress(address.id, { zip: value })
								}
								keyboardType="numeric"
							/>
							<TextInput
								className="flex-1 rounded-lg border border-input bg-background px-4 py-2 text-foreground"
								placeholder="Country"
								value={address.country}
								onChangeText={(value) =>
									updateAddress(address.id, { country: value })
								}
							/>
						</View>
					</View>
				))}
			</View>

			{/* Government IDs */}
			<View className="mb-4 rounded-lg border border-border p-4">
				<Text className="mb-3 font-semibold text-foreground">
					Government IDs
				</Text>
				<View className="mb-4">
					<Text className="mb-2 font-medium text-foreground text-sm">
						Social Security Number
					</Text>
					<TextInput
						className="rounded-lg border border-input bg-background px-4 py-3 font-mono text-foreground"
						placeholder="123-45-6789"
						value={ssn}
						onChangeText={setSsn}
						secureTextEntry
						keyboardType="numeric"
					/>
				</View>
				<View className="mb-4">
					<Text className="mb-2 font-medium text-foreground text-sm">
						Passport Number
					</Text>
					<TextInput
						className="rounded-lg border border-input bg-background px-4 py-3 font-mono text-foreground"
						placeholder="A12345678"
						value={passportNumber}
						onChangeText={setPassportNumber}
						secureTextEntry
					/>
				</View>
				<View>
					<Text className="mb-2 font-medium text-foreground text-sm">
						Driver's License
					</Text>
					<TextInput
						className="rounded-lg border border-input bg-background px-4 py-3 font-mono text-foreground"
						placeholder="D12345678"
						value={driversLicense}
						onChangeText={setDriversLicense}
						secureTextEntry
					/>
				</View>
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
				numberOfLines={10}
				textAlignVertical="top"
				style={{ minHeight: 200 }}
			/>
		</View>
	);

	// Handle QR code scan result for TOTP
	const handleTotpQrScanSuccess = (data: ParsedOtpAuthUri) => {
		setTotpSecret(data.secret);
		if (data.issuer) setTotpIssuer(data.issuer);
		if (data.accountName) setTotpAccountName(data.accountName);
		if (data.algorithm) setTotpAlgorithm(data.algorithm);
		if (data.digits) setTotpDigits(data.digits);
		if (data.period) setTotpPeriod(data.period);
		Alert.alert("Success", "TOTP data imported from QR code");
	};

	// Handle paste from clipboard for TOTP
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
						handleTotpQrScanSuccess(parsed);
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

			{/* Advanced TOTP Settings */}
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

	const renderTagsSection = () => (
		<View className="mb-4">
			<View className="mb-2 flex-row items-center justify-between">
				<Text className="font-medium text-foreground text-sm">Tags</Text>
			</View>
			<View className="flex-row flex-wrap">
				{tags.map((tag) => (
					<View
						key={tag}
						className="mr-2 mb-2 flex-row items-center rounded-full bg-secondary px-3 py-1"
					>
						<Text className="text-foreground text-sm">{tag}</Text>
						<TouchableOpacity onPress={() => removeTag(tag)} className="ml-2">
							<Trash2 size={12} color="#6b7280" />
						</TouchableOpacity>
					</View>
				))}
			</View>
			<View className="flex-row items-center gap-2">
				<TextInput
					className="flex-1 rounded-lg border border-input bg-background px-4 py-2 text-foreground"
					placeholder="Add a tag..."
					value={newTag}
					onChangeText={setNewTag}
					onSubmitEditing={addTag}
					returnKeyType="done"
				/>
				<TouchableOpacity
					onPress={addTag}
					className="rounded-lg bg-secondary px-4 py-2"
				>
					<Text className="text-foreground text-sm">Add</Text>
				</TouchableOpacity>
			</View>
		</View>
	);

	const renderCustomFieldsSection = () => (
		<View className="mb-4">
			<View className="mb-2 flex-row items-center justify-between">
				<Text className="font-medium text-foreground text-sm">
					Custom Fields
				</Text>
				<TouchableOpacity
					onPress={addCustomField}
					className="flex-row items-center rounded-lg bg-secondary px-3 py-1"
				>
					<Plus size={14} color="#6b7280" />
					<Text className="ml-1 text-foreground text-sm">Add</Text>
				</TouchableOpacity>
			</View>
			{customFields.map((field) => (
				<View
					key={field.id}
					className="mb-2 rounded-lg border border-border p-3"
				>
					<View className="mb-2 flex-row items-center gap-2">
						<TextInput
							className="flex-1 rounded-lg border border-input bg-background px-4 py-2 text-foreground"
							placeholder="Field label"
							value={field.label}
							onChangeText={(value) =>
								updateCustomField(field.id, { label: value })
							}
						/>
						<View className="rounded-lg border border-input bg-background px-3 py-2">
							<TouchableOpacity
								onPress={() => {
									const types: CustomField["type"][] = [
										"text",
										"password",
										"email",
										"url",
									];
									const currentIndex = types.indexOf(field.type);
									const nextType = types[(currentIndex + 1) % types.length];
									updateCustomField(field.id, { type: nextType });
								}}
							>
								<Text className="text-foreground text-sm capitalize">
									{field.type}
								</Text>
							</TouchableOpacity>
						</View>
						<TouchableOpacity
							onPress={() => removeCustomField(field.id)}
							className="rounded-lg bg-destructive/10 p-2"
						>
							<Trash2 size={16} color="#ef4444" />
						</TouchableOpacity>
					</View>
					<TextInput
						className="rounded-lg border border-input bg-background px-4 py-2 text-foreground"
						placeholder="Value"
						value={field.value}
						onChangeText={(value) =>
							updateCustomField(field.id, { value: value })
						}
						secureTextEntry={field.type === "password"}
					/>
				</View>
			))}
		</View>
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
				onScanSuccess={handleTotpQrScanSuccess}
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
					<View className="mr-3 h-10 w-10 items-center justify-center rounded-lg bg-secondary">
						{CategoryIcon && <CategoryIcon size={20} color="#6b7280" />}
					</View>
					<View className="flex-1">
						<Text className="font-bold text-foreground text-xl">Edit Item</Text>
						<Text className="text-muted-foreground text-sm">
							{categoryOptions.find((c) => c.value === item.category)?.label}
						</Text>
					</View>
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
					{/* Title */}
					<View className="my-4">
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
					{item.category === "login" && renderLoginFields()}
					{item.category === "credit-card" && renderCreditCardFields()}
					{item.category === "identity" && renderIdentityFields()}
					{item.category === "secure-note" && renderSecureNoteFields()}
					{item.category === "totp" && renderTotpFields()}

					{/* Notes (for non-secure-note items) */}
					{item.category !== "secure-note" && (
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

					{/* Tags Section */}
					{renderTagsSection()}

					{/* Custom Fields Section */}
					{renderCustomFieldsSection()}

					{/* Bottom padding */}
					<View className="h-8" />
				</ScrollView>
			</KeyboardAvoidingView>
		</SafeAreaView>
	);
}
