import { useVaultItems } from "@bittery/hooks";
import {
	detectCardBrand,
	formatCardNumber as formatCardNumberUtil,
	getCardBrandDisplayName,
} from "@bittery/shared/credit-card";
import type { ItemCategory } from "@bittery/shared/types";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
	ArrowLeft,
	Copy,
	CreditCard,
	Edit,
	Eye,
	EyeOff,
	FileText,
	Globe,
	Key,
	Mail,
	Star,
	Timer,
	User,
} from "lucide-react-native";
import { useState } from "react";
import {
	ActivityIndicator,
	Alert,
	ScrollView,
	Text,
	TouchableOpacity,
	View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { TotpDisplay } from "../../../src/components/totp-display";

const categoryIcons: Record<ItemCategory, typeof Key> = {
	login: Key,
	"credit-card": CreditCard,
	identity: User,
	"secure-note": FileText,
	totp: Timer,
};

const categoryLabels: Record<ItemCategory, string> = {
	login: "Login",
	"credit-card": "Credit Card",
	identity: "Identity",
	"secure-note": "Secure Note",
	totp: "TOTP",
};

export default function ItemDetailScreen() {
	const router = useRouter();
	const { vaultId, itemId } = useLocalSearchParams<{
		vaultId: string;
		itemId: string;
	}>();

	const { items, isLoading, error } = useVaultItems(vaultId);
	const [showPassword, setShowPassword] = useState(false);
	const [showCardNumber, setShowCardNumber] = useState(false);
	const [showCvv, setShowCvv] = useState(false);
	const [showSsn, setShowSsn] = useState(false);
	const [showTotpSecret, setShowTotpSecret] = useState(false);

	const item = items.find((i) => i.id === itemId);

	const handleCopy = async (value: string, label: string) => {
		await Clipboard.setStringAsync(value);
		Alert.alert("Copied", `${label} copied to clipboard`);
	};

	const maskValue = (value: string, visibleChars = 4) => {
		if (value.length <= visibleChars) return "•".repeat(value.length);
		return "•".repeat(value.length - visibleChars) + value.slice(-visibleChars);
	};

	const formatCardNumber = (number: string) => {
		const brand = detectCardBrand(number);
		return formatCardNumberUtil(number, brand);
	};

	if (isLoading) {
		return (
			<SafeAreaView className="flex-1 items-center justify-center bg-background">
				<ActivityIndicator size="large" color="#000" />
			</SafeAreaView>
		);
	}

	if (error) {
		return (
			<SafeAreaView className="flex-1 items-center justify-center bg-background">
				<Text className="text-destructive">Error loading item</Text>
				<Text className="mt-2 px-4 text-center text-muted-foreground text-sm">
					{error instanceof Error ? error.message : "Unknown error"}
				</Text>
				<TouchableOpacity
					onPress={() => router.back()}
					className="mt-4 rounded-lg bg-primary px-4 py-2"
				>
					<Text className="text-primary-foreground">Go Back</Text>
				</TouchableOpacity>
			</SafeAreaView>
		);
	}

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

	const Icon = categoryIcons[item.category];

	const renderFieldRow = (
		label: string,
		value: string | undefined,
		options?: {
			masked?: boolean;
			showState?: boolean;
			setShowState?: (show: boolean) => void;
			icon?: typeof Key;
		},
	) => {
		if (!value) return null;

		const displayValue =
			options?.masked && !options?.showState ? maskValue(value) : value;

		return (
			<View className="border-border border-b py-4">
				<Text className="mb-1 text-muted-foreground text-sm">{label}</Text>
				<View className="flex-row items-center gap-2.5">
					{options?.icon && <options.icon size={16} color="#6b7280" />}
					<Text className="flex-1 text-foreground" selectable>
						{displayValue}
					</Text>
					{options?.masked && options?.setShowState && (
						<TouchableOpacity
							onPress={() => options.setShowState?.(!options.showState)}
							className="mr-2 p-2"
						>
							{options.showState ? (
								<EyeOff size={18} color="#6b7280" />
							) : (
								<Eye size={18} color="#6b7280" />
							)}
						</TouchableOpacity>
					)}
					<TouchableOpacity
						onPress={() => handleCopy(value, label)}
						className="p-2"
					>
						<Copy size={18} color="#6b7280" />
					</TouchableOpacity>
				</View>
			</View>
		);
	};

	const renderLoginFields = () => (
		<>
			{renderFieldRow("Username", item.username, { icon: User })}
			{renderFieldRow("Password", item.password, {
				masked: true,
				showState: showPassword,
				setShowState: setShowPassword,
				icon: Key,
			})}
			{renderFieldRow("Website", item.url, { icon: Globe })}
			{item.urls &&
				item.urls.length > 1 &&
				item.urls.slice(1).map((url, index) => (
					<View key={url} className="border-border border-b py-4">
						<Text className="mb-1 text-muted-foreground text-sm">
							Website {index + 2}
						</Text>
						<View className="flex-row items-center">
							<Globe size={16} color="#6b7280" className="mr-2" />
							<Text className="flex-1 text-foreground" selectable>
								{url}
							</Text>
							<TouchableOpacity
								onPress={() => handleCopy(url, "URL")}
								className="p-2"
							>
								<Copy size={18} color="#6b7280" />
							</TouchableOpacity>
						</View>
					</View>
				))}
			{/* TOTP Section for Login Items */}
			{item.totpSecret && (
				<View className="border-border border-b py-4">
					<Text className="mb-2 text-muted-foreground text-sm">
						Two-Factor Code
					</Text>
					<TotpDisplay
						totpSecret={item.totpSecret}
						totpAlgorithm={item.totpAlgorithm}
						totpDigits={item.totpDigits}
						totpPeriod={item.totpPeriod}
						label={item.totpIssuer || "One-time password"}
					/>
				</View>
			)}
		</>
	);

	const renderCreditCardFields = () => {
		const cardBrand = item.cardNumber ? detectCardBrand(item.cardNumber) : null;
		const brandDisplayName =
			cardBrand && cardBrand !== "unknown"
				? getCardBrandDisplayName(cardBrand)
				: null;

		return (
			<>
				{renderFieldRow("Cardholder Name", item.cardholderName)}
				{item.cardNumber && (
					<View className="border-border border-b py-4">
						<View className="mb-1 flex-row items-center justify-between">
							<Text className="text-muted-foreground text-sm">Card Number</Text>
							{brandDisplayName && (
								<Text className="text-muted-foreground text-xs">
									{brandDisplayName}
								</Text>
							)}
						</View>
						<View className="flex-row items-center">
							<CreditCard size={16} color="#6b7280" className="mr-2" />
							<Text className="flex-1 font-mono text-foreground" selectable>
								{showCardNumber
									? formatCardNumber(item.cardNumber)
									: maskValue(item.cardNumber, 4)}
							</Text>
							<TouchableOpacity
								onPress={() => setShowCardNumber(!showCardNumber)}
								className="mr-2 p-2"
							>
								{showCardNumber ? (
									<EyeOff size={18} color="#6b7280" />
								) : (
									<Eye size={18} color="#6b7280" />
								)}
							</TouchableOpacity>
							<TouchableOpacity
								onPress={() => handleCopy(item.cardNumber ?? "", "Card Number")}
								className="p-2"
							>
								<Copy size={18} color="#6b7280" />
							</TouchableOpacity>
						</View>
					</View>
				)}
				{renderFieldRow("Expiry Date", item.expiryDate)}
				{renderFieldRow("CVV", item.cvv, {
					masked: true,
					showState: showCvv,
					setShowState: setShowCvv,
				})}
				{renderFieldRow("Billing Address", item.billingAddress)}
			</>
		);
	};

	const renderIdentityFields = () => (
		<>
			{(item.firstName || item.lastName) && (
				<View className="border-border border-b py-4">
					<Text className="mb-1 text-muted-foreground text-sm">Name</Text>
					<Text className="text-foreground" selectable>
						{[item.firstName, item.middleName, item.lastName]
							.filter(Boolean)
							.join(" ")}
					</Text>
				</View>
			)}
			{renderFieldRow("Email", item.email, { icon: Mail })}
			{renderFieldRow("Date of Birth", item.dateOfBirth)}
			{renderFieldRow("SSN", item.ssn, {
				masked: true,
				showState: showSsn,
				setShowState: setShowSsn,
			})}
			{renderFieldRow("Passport Number", item.passportNumber)}
			{renderFieldRow("Driver's License", item.driversLicense)}
			{item.addresses?.map((address, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: addresses don't have unique IDs
				<View key={`address-${index}`} className="border-border border-b py-4">
					<Text className="mb-1 text-muted-foreground text-sm">
						{address.city} {address.country}
					</Text>
					<Text className="text-foreground" selectable>
						{[
							address.street,
							address.city,
							address.state,
							address.zip,
							address.country,
						]
							.filter(Boolean)
							.join(", ")}
					</Text>
				</View>
			))}
			{item.phoneNumbers?.map((phone, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: phone numbers don't have unique IDs
				<View key={`phone-${index}`} className="border-border border-b py-4">
					<Text className="mb-1 text-muted-foreground text-sm">
						{phone.label || `Phone ${index + 1}`}
					</Text>
					<View className="flex-row items-center">
						<Text className="flex-1 text-foreground" selectable>
							{phone.number}
						</Text>
						<TouchableOpacity
							onPress={() => handleCopy(phone.number, "Phone")}
							className="p-2"
						>
							<Copy size={18} color="#6b7280" />
						</TouchableOpacity>
					</View>
				</View>
			))}
		</>
	);

	const renderSecureNoteFields = () => (
		<View className="py-4">
			<Text className="mb-2 text-muted-foreground text-sm">Note</Text>
			<Text className="text-foreground" selectable>
				{item.note || item.notes}
			</Text>
		</View>
	);

	const renderTotpFields = () => (
		<>
			{/* Live TOTP Code Display */}
			{item.totpSecret && (
				<View className="border-border border-b py-4">
					<Text className="mb-2 text-muted-foreground text-sm">
						Current Code
					</Text>
					<TotpDisplay
						totpSecret={item.totpSecret}
						totpAlgorithm={item.totpAlgorithm}
						totpDigits={item.totpDigits}
						totpPeriod={item.totpPeriod}
					/>
				</View>
			)}
			{renderFieldRow("Secret", item.totpSecret, {
				masked: true,
				showState: showTotpSecret,
				setShowState: setShowTotpSecret,
			})}
			{renderFieldRow("Issuer", item.totpIssuer)}
			{renderFieldRow("Account", item.totpAccountName)}
			{/* Show TOTP settings if non-default */}
			{item.totpAlgorithm && item.totpAlgorithm !== "SHA1" && (
				<View className="border-border border-b py-4">
					<Text className="mb-1 text-muted-foreground text-sm">Algorithm</Text>
					<Text className="text-foreground">{item.totpAlgorithm}</Text>
				</View>
			)}
			{item.totpDigits && item.totpDigits !== 6 && (
				<View className="border-border border-b py-4">
					<Text className="mb-1 text-muted-foreground text-sm">Digits</Text>
					<Text className="text-foreground">{item.totpDigits}</Text>
				</View>
			)}
			{item.totpPeriod && item.totpPeriod !== 30 && (
				<View className="border-border border-b py-4">
					<Text className="mb-1 text-muted-foreground text-sm">Period</Text>
					<Text className="text-foreground">{item.totpPeriod} seconds</Text>
				</View>
			)}
		</>
	);

	return (
		<SafeAreaView className="flex-1 bg-background">
			{/* Header */}
			<View className="flex-row items-center border-border border-b px-4 py-4">
				<TouchableOpacity
					onPress={() => router.back()}
					className="mr-3 rounded-full bg-secondary p-2"
				>
					<ArrowLeft size={20} color="#6b7280" />
				</TouchableOpacity>
				<View className="mr-3 h-10 w-10 items-center justify-center rounded-lg bg-secondary">
					<Icon size={20} color="#6b7280" />
				</View>
				<View className="flex-1">
					<View className="flex-row items-center">
						<Text className="font-semibold text-foreground">{item.title}</Text>
						{item.favorite && (
							<Star size={14} color="#eab308" fill="#eab308" className="ml-2" />
						)}
					</View>
					<Text className="text-muted-foreground text-sm">
						{categoryLabels[item.category]}
					</Text>
				</View>
				<TouchableOpacity
					onPress={() => router.push(`/(vault)/${vaultId}/edit/${itemId}`)}
					className="rounded-lg bg-primary px-4 py-2"
				>
					<View className="flex-row items-center">
						<Edit size={16} color="#fff" />
						<Text className="ml-2 font-medium text-primary-foreground">
							Edit
						</Text>
					</View>
				</TouchableOpacity>
			</View>

			<ScrollView className="flex-1 px-4">
				{/* Category-specific fields */}
				{item.category === "login" && renderLoginFields()}
				{item.category === "credit-card" && renderCreditCardFields()}
				{item.category === "identity" && renderIdentityFields()}
				{item.category === "secure-note" && renderSecureNoteFields()}
				{item.category === "totp" && renderTotpFields()}

				{/* Notes (for non-secure-note items) */}
				{item.category !== "secure-note" && (item.notes || item.note) && (
					<View className="border-border border-b py-4">
						<Text className="mb-2 text-muted-foreground text-sm">Notes</Text>
						<Text className="text-foreground" selectable>
							{item.notes || item.note}
						</Text>
					</View>
				)}

				{/* Tags */}
				{item.tags && item.tags.length > 0 && (
					<View className="py-4">
						<Text className="mb-2 text-muted-foreground text-sm">Tags</Text>
						<View className="flex-row flex-wrap">
							{item.tags.map((tag) => (
								<View
									key={tag}
									className="mr-2 mb-2 rounded-full bg-secondary px-3 py-1"
								>
									<Text className="text-foreground text-sm">{tag}</Text>
								</View>
							))}
						</View>
					</View>
				)}

				{/* Custom Fields */}
				{item.customFields?.map((field) => (
					<View key={field.id} className="border-border border-b py-4">
						<Text className="mb-1 text-muted-foreground text-sm">
							{field.label}
						</Text>
						<View className="flex-row items-center">
							<Text className="flex-1 text-foreground" selectable>
								{field.type === "password"
									? maskValue(field.value)
									: field.value}
							</Text>
							<TouchableOpacity
								onPress={() => handleCopy(field.value, field.label)}
								className="p-2"
							>
								<Copy size={18} color="#6b7280" />
							</TouchableOpacity>
						</View>
					</View>
				))}

				{/* Metadata */}
				<View className="py-4">
					<Text className="text-muted-foreground text-xs">
						Created: {new Date(item.createdAt).toLocaleString()}
					</Text>
					<Text className="text-muted-foreground text-xs">
						Updated: {new Date(item.updatedAt).toLocaleString()}
					</Text>
				</View>
			</ScrollView>
		</SafeAreaView>
	);
}
