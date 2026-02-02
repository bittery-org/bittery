import { useAllVaultKeys, useCreateItem } from "@bittery/hooks";
import {
	type CardBrand,
	detectCardBrand,
	formatCardNumber,
	getCardBrandDisplayName,
} from "@bittery/shared/credit-card";
import {
	isValidBase32,
	type ParsedOtpAuthUri,
	parseOtpAuthUri,
} from "@bittery/shared/totp";
import type {
	DecryptedItemData,
	ItemCategory,
	TotpAlgorithm,
	TotpDigits,
} from "@bittery/shared/types";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, Label, Select, TextField } from "heroui-native";
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
	Vault,
} from "lucide-react-native";
import { useState } from "react";
import {
	Alert,
	KeyboardAvoidingView,
	Platform,
	Pressable,
	ScrollView,
	Text,
	View,
} from "react-native";
import { withUniwind } from "uniwind";
import { SafeAreaView } from "@/components/safe-area-view";
import { PasswordGenerator } from "../../src/components/password-generator";
import { QrCodeScanner } from "../../src/components/qr-code-scanner";
import { TotpDisplay } from "../../src/components/totp-display";
import { VaultAvatar } from "../../src/components/vault-avatar";

// Create styled icon components
const StyledKey = withUniwind(Key);
const StyledCreditCard = withUniwind(CreditCard);
const StyledUser = withUniwind(User);
const StyledFileText = withUniwind(FileText);
const StyledTimer = withUniwind(Timer);
const StyledEye = withUniwind(Eye);
const StyledEyeOff = withUniwind(EyeOff);
const StyledArrowLeft = withUniwind(ArrowLeft);
const StyledSparkles = withUniwind(Sparkles);
const StyledCamera = withUniwind(Camera);
const StyledClipboardPaste = withUniwind(ClipboardPaste);
const StyledVault = withUniwind(Vault);
const StyledChevronDown = withUniwind(ChevronDown);
const StyledChevronRight = withUniwind(ChevronRight);

const categoryOptions: {
	value: ItemCategory;
	label: string;
	icon: typeof StyledKey;
}[] = [
	{ value: "login", label: "Login", icon: StyledKey },
	{ value: "credit-card", label: "Credit Card", icon: StyledCreditCard },
	{ value: "identity", label: "Identity", icon: StyledUser },
	{ value: "secure-note", label: "Secure Note", icon: StyledFileText },
	{ value: "totp", label: "TOTP", icon: StyledTimer },
];

export default function CreateItemScreen() {
	const router = useRouter();
	const { vaultId: vaultIdParam } = useLocalSearchParams<{ vaultId?: string }>();
	const createItem = useCreateItem();
	const { vaultKeys = [], isLoading: isLoadingVaults } = useAllVaultKeys();

	// Vault selection state
	const [selectedVaultId, setSelectedVaultId] = useState<string | undefined>(
		vaultIdParam,
	);

	const [category, setCategory] = useState<
		{ value: ItemCategory; label: string } | undefined
	>({ value: "login", label: "Login" });
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

		if (!selectedVaultId) {
			Alert.alert("Error", "Please select a vault");
			return;
		}

		setSaving(true);

		try {
			// Build the data object based on category
			let itemData: DecryptedItemData = { title };
			const categoryValue = category?.value || "login";

			switch (categoryValue) {
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

			// Create the item using shared hook (handles encryption internally)
			await createItem.mutateAsync({
				vaultId: selectedVaultId,
				category: categoryValue,
				data: itemData,
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
			<TextField className="mb-4">
				<TextField.Label>Username</TextField.Label>
				<TextField.Input
					placeholder="Enter username"
					value={username}
					onChangeText={setUsername}
					autoCapitalize="none"
					autoCorrect={false}
				/>
			</TextField>

			<TextField className="mb-4">
				<TextField.Label>Password</TextField.Label>
				<View className="w-full flex-row items-center gap-2">
					<View className="flex-1 flex-row items-center">
						<TextField.Input
							placeholder="Enter password"
							value={password}
							onChangeText={setPassword}
							secureTextEntry={!showPassword}
							className="flex-1 pr-12"
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
					<Button
						isIconOnly
						onPress={() => setShowPasswordGenerator(true)}
						variant="primary"
					>
						<StyledSparkles size={20} className="text-accent-foreground" />
					</Button>
				</View>
			</TextField>

			<TextField className="mb-4">
				<TextField.Label>Website URL</TextField.Label>
				<TextField.Input
					placeholder="https://example.com"
					value={url}
					onChangeText={setUrl}
					autoCapitalize="none"
					autoCorrect={false}
					keyboardType="url"
				/>
			</TextField>
		</>
	);

	// Card number change handler with brand detection and formatting
	const handleCardNumberChange = (value: string) => {
		const cleaned = value.replace(/\D/g, "");

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
			<TextField className="mb-4">
				<TextField.Label>Cardholder Name</TextField.Label>
				<TextField.Input
					placeholder="Name on card"
					value={cardholderName}
					onChangeText={setCardholderName}
					autoCapitalize="words"
				/>
			</TextField>

			<TextField className="mb-4">
				<View className="mb-2 flex-row items-center justify-between">
					<TextField.Label>Card Number</TextField.Label>
					{detectedCardBrand && detectedCardBrand !== "unknown" && (
						<Text className="text-muted-foreground text-xs">
							{getCardBrandDisplayName(detectedCardBrand)}
						</Text>
					)}
				</View>
				<TextField.Input
					placeholder="1234 5678 9012 3456"
					value={formatCardNumber(cardNumber, detectedCardBrand || undefined)}
					onChangeText={handleCardNumberChange}
					keyboardType="numeric"
					maxLength={23}
					className="font-mono"
				/>
			</TextField>

			<View className="mb-4 flex-row gap-2">
				<TextField className="flex-1">
					<TextField.Label>Expiry</TextField.Label>
					<TextField.Input
						placeholder="MM/YY"
						value={expiryDate}
						onChangeText={handleExpiryChange}
						keyboardType="numeric"
						maxLength={5}
						className="font-mono"
					/>
				</TextField>

				<TextField className="flex-1">
					<TextField.Label>CVV</TextField.Label>
					<View className="w-full flex-row items-center">
						<TextField.Input
							placeholder="123"
							value={cvv}
							onChangeText={handleCvvChange}
							keyboardType="numeric"
							secureTextEntry={!showCvv}
							maxLength={detectedCardBrand === "amex" ? 4 : 3}
							className="flex-1 pr-12 font-mono"
						/>
						<Pressable
							onPress={() => setShowCvv(!showCvv)}
							className="absolute right-4"
						>
							{showCvv ? (
								<StyledEyeOff size={20} className="text-muted" />
							) : (
								<StyledEye size={20} className="text-muted" />
							)}
						</Pressable>
					</View>
				</TextField>
			</View>

			<TextField className="mb-4">
				<TextField.Label>Billing Address</TextField.Label>
				<TextField.Input
					placeholder="123 Main St, City, State ZIP"
					value={billingAddress}
					onChangeText={setBillingAddress}
					multiline
					numberOfLines={2}
					textAlignVertical="top"
					style={{ minHeight: 60 }}
				/>
			</TextField>
		</>
	);

	const renderIdentityFields = () => (
		<>
			<View className="mb-4 flex-row gap-2">
				<TextField className="flex-1">
					<TextField.Label>First Name</TextField.Label>
					<TextField.Input
						placeholder="First name"
						value={firstName}
						onChangeText={setFirstName}
						autoCapitalize="words"
					/>
				</TextField>

				<TextField className="flex-1">
					<TextField.Label>Last Name</TextField.Label>
					<TextField.Input
						placeholder="Last name"
						value={lastName}
						onChangeText={setLastName}
						autoCapitalize="words"
					/>
				</TextField>
			</View>

			<TextField className="mb-4">
				<TextField.Label>Email</TextField.Label>
				<TextField.Input
					placeholder="email@example.com"
					value={email}
					onChangeText={setEmail}
					autoCapitalize="none"
					keyboardType="email-address"
				/>
			</TextField>
		</>
	);

	const renderSecureNoteFields = () => (
		<TextField className="mb-4">
			<TextField.Label>Note</TextField.Label>
			<TextField.Input
				placeholder="Enter your secure note..."
				value={note}
				onChangeText={setNote}
				multiline
				numberOfLines={6}
				textAlignVertical="top"
				style={{ minHeight: 120 }}
			/>
		</TextField>
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
				<Button
					onPress={() => setShowQrScanner(true)}
					variant="secondary"
					className="flex-1"
				>
					<StyledCamera size={18} className="text-accent-soft-foreground" />
					<Button.Label>Scan QR</Button.Label>
				</Button>
				<Button
					onPress={handlePasteTotp}
					variant="secondary"
					className="flex-1"
				>
					<StyledClipboardPaste size={18} className="text-accent-soft-foreground" />
					<Button.Label>Paste</Button.Label>
				</Button>
			</View>

			{/* Secret Key Input */}
			<TextField
				className="mb-4"
				isRequired
				isInvalid={totpSecret && !isValidBase32(totpSecret) ? true : undefined}
			>
				<TextField.Label>Secret Key</TextField.Label>
				<TextField.Input
					placeholder="JBSWY3DPEHPK3PXP"
					value={totpSecret}
					onChangeText={setTotpSecret}
					autoCapitalize="characters"
					autoCorrect={false}
					className="font-mono"
				/>
				{totpSecret && !isValidBase32(totpSecret) && (
					<TextField.ErrorMessage>
						Invalid base32 format. Please check the secret key.
					</TextField.ErrorMessage>
				)}
			</TextField>

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
				<TextField className="flex-1">
					<TextField.Label>Service</TextField.Label>
					<TextField.Input
						placeholder="Google, GitHub..."
						value={totpIssuer}
						onChangeText={setTotpIssuer}
					/>
				</TextField>

				<TextField className="flex-1">
					<TextField.Label>Account</TextField.Label>
					<TextField.Input
						placeholder="your@email.com"
						value={totpAccountName}
						onChangeText={setTotpAccountName}
					/>
				</TextField>
			</View>

			{/* Advanced Settings */}
			<Pressable
				onPress={() => setShowTotpAdvanced(!showTotpAdvanced)}
				className="mb-4 flex-row items-center justify-between rounded-lg border border-border p-3"
			>
				<Text className="font-medium text-foreground text-sm">
					Advanced Settings
				</Text>
				{showTotpAdvanced ? (
					<StyledChevronDown size={16} className="text-muted" />
				) : (
					<StyledChevronRight size={16} className="text-muted" />
				)}
			</Pressable>
			{showTotpAdvanced && (
				<View className="mb-4 rounded-lg bg-secondary/30 p-3">
					<View className="mb-4 flex-row gap-2">
						<View className="flex-1">
							<Text className="mb-1 text-muted-foreground text-xs">Digits</Text>
							<View className="flex-row rounded-lg border border-input bg-background">
								{[6, 7, 8].map((d) => (
									<Pressable
										key={d}
										onPress={() => setTotpDigits(d as TotpDigits)}
										className={`flex-1 items-center py-2 ${totpDigits === d ? "bg-primary" : ""}`}
									>
										<Text
											className={`text-sm ${totpDigits === d ? "text-primary-foreground" : "text-foreground"}`}
										>
											{d}
										</Text>
									</Pressable>
								))}
							</View>
						</View>
						<TextField className="flex-1">
							<TextField.Label className="mb-1 text-muted-foreground text-xs">
								Period (sec)
							</TextField.Label>
							<TextField.Input
								value={totpPeriod.toString()}
								onChangeText={(v: string) =>
									setTotpPeriod(Number.parseInt(v, 10) || 30)
								}
								keyboardType="numeric"
							/>
						</TextField>
					</View>
					<View>
						<Text className="mb-1 text-muted-foreground text-xs">
							Algorithm
						</Text>
						<View className="flex-row rounded-lg border border-input bg-background">
							{(["SHA1", "SHA256", "SHA512"] as TotpAlgorithm[]).map((algo) => (
								<Pressable
									key={algo}
									onPress={() => setTotpAlgorithm(algo)}
									className={`flex-1 items-center py-2 ${totpAlgorithm === algo ? "bg-primary" : ""}`}
								>
									<Text
										className={`text-xs ${totpAlgorithm === algo ? "text-primary-foreground" : "text-foreground"}`}
									>
										{algo}
									</Text>
								</Pressable>
							))}
						</View>
					</View>
				</View>
			)}
		</>
	);

	const selectedVault = vaultKeys.find((v) => v.vaultId === selectedVaultId);
	const selectedCategoryOption = categoryOptions.find(
		(opt) => opt.value === category?.value,
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
					<Button
						isIconOnly
						onPress={() => router.back()}
						variant="secondary"
						size="sm"
						className="mr-3"
					>
						<StyledArrowLeft size={20} className="text-foreground" />
					</Button>
					<Text className="flex-1 font-bold text-foreground text-xl">
						New Item
					</Text>
					<Button
						onPress={handleSave}
						isDisabled={saving}
						variant="primary"
						size="sm"
					>
						{saving ? "Saving..." : "Save"}
					</Button>
				</View>

				<ScrollView className="flex-1 px-4" keyboardShouldPersistTaps="handled">
					{/* Vault Selector */}
					<View className="my-4">
						<Label className="mb-2">Vault</Label>
						<Select
							value={
								selectedVaultId
									? { value: selectedVaultId, label: selectedVault?.vaultName || "" }
									: undefined
							}
							onValueChange={(option) => {
								setSelectedVaultId(option?.value);
							}}
							isDisabled={isLoadingVaults || !!vaultIdParam}
						>
							<Select.Trigger asChild>
								<Button variant="secondary" size="md" className="w-full justify-start">
									{selectedVault ? (
									<VaultAvatar
										name={selectedVault.vaultName}
										icon={selectedVault.vaultIcon}
										imageUrl={selectedVault.vaultImageUrl}
										size="sm"
									/>
								) : (
									<StyledVault size={20} className="text-muted" />
								)}
									<Button.Label className="flex-1 text-left">
										{selectedVault?.vaultName || "Select Vault"}
									</Button.Label>
									<StyledChevronDown size={16} className="text-muted" />
								</Button>
							</Select.Trigger>
							<Select.Portal>
								<Select.Overlay />
								<Select.Content
									presentation="popover"
									width="trigger"
									className="h-[250px] rounded-2xl"
									placement="bottom"
								>
									<ScrollView>
										{vaultKeys.map((vault) => (
											<Select.Item
												key={vault.vaultId}
												value={vault.vaultId}
												label={vault.vaultName}
											>
												<View className="flex-1 flex-row items-center gap-3">
													<VaultAvatar
													name={vault.vaultName}
													icon={vault.vaultIcon}
													imageUrl={vault.vaultImageUrl}
													size="sm"
												/>
													<Text className="flex-1 text-base text-foreground">
														{vault.vaultName}
													</Text>
												</View>
												<Select.ItemIndicator />
											</Select.Item>
										))}
									</ScrollView>
								</Select.Content>
							</Select.Portal>
						</Select>
					</View>

					{/* Category Selector */}
					<View className="my-4">
						<Label className="mb-2">Category</Label>
						<Select
							value={category}
							onValueChange={(option) => {
								if (option) {
									setCategory({
										value: option.value as ItemCategory,
										label: option.label,
									});
								}
							}}
						>
							<Select.Trigger asChild>
								<Button variant="tertiary" size="md" className="w-full justify-start">
									{selectedCategoryOption ? (
										<>
											<selectedCategoryOption.icon
												size={20}
												className="text-muted"
											/>
											<Button.Label className="flex-1 text-left">
												{selectedCategoryOption.label}
											</Button.Label>
										</>
									) : (
										<Button.Label className="flex-1 text-left">
											Select Category
										</Button.Label>
									)}
									<StyledChevronDown size={16} className="text-muted" />
								</Button>
							</Select.Trigger>
							<Select.Portal>
								<Select.Overlay />
								<Select.Content
									presentation="popover"
									width="trigger"
									className="h-[280px] rounded-2xl"
									placement="bottom"
								>
									<ScrollView>
										{categoryOptions.map((option) => {
											const Icon = option.icon;
											return (
												<Select.Item
													key={option.value}
													value={option.value}
													label={option.label}
												>
													<View className="flex-1 flex-row items-center gap-3">
														<Icon size={18} className="text-muted" />
														<Text className="flex-1 text-base text-foreground">
															{option.label}
														</Text>
													</View>
													<Select.ItemIndicator />
												</Select.Item>
											);
										})}
									</ScrollView>
								</Select.Content>
							</Select.Portal>
						</Select>
					</View>

					{/* Title */}
					<TextField className="mb-4" isRequired>
						<TextField.Label>Title</TextField.Label>
						<TextField.Input
							placeholder="Enter title"
							value={title}
							onChangeText={setTitle}
						/>
					</TextField>

					{/* Category-specific fields */}
					{category?.value === "login" && renderLoginFields()}
					{category?.value === "credit-card" && renderCreditCardFields()}
					{category?.value === "identity" && renderIdentityFields()}
					{category?.value === "secure-note" && renderSecureNoteFields()}
					{category?.value === "totp" && renderTotpFields()}

					{/* Notes (for non-secure-note items) */}
					{category?.value !== "secure-note" && (
						<TextField className="mb-4">
							<TextField.Label>Notes (optional)</TextField.Label>
							<TextField.Input
								placeholder="Add any additional notes..."
								value={notes}
								onChangeText={setNotes}
								multiline
								numberOfLines={3}
								textAlignVertical="top"
								style={{ minHeight: 80 }}
							/>
						</TextField>
					)}

					{/* Bottom padding */}
					<View className="h-8" />
				</ScrollView>
			</KeyboardAvoidingView>
		</SafeAreaView>
	);
}
