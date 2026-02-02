import { useUpdateItem, useVaultItems } from "@bittery/hooks";
import type {
	CustomField,
	DecryptedItemData,
	ItemCategory,
} from "@bittery/shared/types";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, TextField } from "heroui-native";
import {
	ArrowLeft,
	CreditCard,
	FileText,
	Key,
	Timer,
	User,
} from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	KeyboardAvoidingView,
	Platform,
	ScrollView,
	Text,
	View,
} from "react-native";
import { withUniwind } from "uniwind";
import {
	CreditCardForm,
	type CreditCardFormRef,
	IdentityForm,
	type IdentityFormRef,
	LoginForm,
	type LoginFormRef,
	SecureNoteForm,
	type SecureNoteFormRef,
	TotpForm,
	type TotpFormRef,
} from "@/components/item-forms";
import { ItemIcon } from "@/components/item-icon";
import { SafeAreaView } from "@/components/safe-area-view";

// Create styled icon components
const StyledKey = withUniwind(Key);
const StyledCreditCard = withUniwind(CreditCard);
const StyledUser = withUniwind(User);
const StyledFileText = withUniwind(FileText);
const StyledTimer = withUniwind(Timer);
const StyledArrowLeft = withUniwind(ArrowLeft);

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

export default function EditItemScreen() {
	const router = useRouter();
	const { vaultId, itemId } = useLocalSearchParams<{
		vaultId: string;
		itemId: string;
	}>();
	const updateItem = useUpdateItem();

	const { items, isLoading } = useVaultItems(vaultId);
	const item = items.find((i) => i.id === itemId);

	const [initialized, setInitialized] = useState(false);
	const [saving, setSaving] = useState(false);
	const [title, setTitle] = useState("");
	const [notes, setNotes] = useState("");
	const [tags, setTags] = useState<string[]>([]);
	const [customFields, setCustomFields] = useState<CustomField[]>([]);

	// Form refs
	const loginFormRef = useRef<LoginFormRef>(null);
	const creditCardFormRef = useRef<CreditCardFormRef>(null);
	const identityFormRef = useRef<IdentityFormRef>(null);
	const secureNoteFormRef = useRef<SecureNoteFormRef>(null);
	const totpFormRef = useRef<TotpFormRef>(null);

	// Initialize form with item data
	useEffect(() => {
		if (item && !initialized) {
			setTitle(item.title || "");
			setNotes(item.notes || "");
			setTags(item.tags || []);
			setCustomFields(item.customFields || []);
			setInitialized(true);
		}
	}, [item, initialized]);

	const handleSave = async () => {
		if (!item) return;
		if (!title.trim()) {
			Alert.alert("Error", "Title is required");
			return;
		}

		// Validate category-specific forms
		let isValid = true;
		switch (item.category) {
			case "login":
				isValid = loginFormRef.current?.isValid() ?? false;
				break;
			case "credit-card":
				isValid = creditCardFormRef.current?.isValid() ?? false;
				break;
			case "identity":
				isValid = identityFormRef.current?.isValid() ?? false;
				break;
			case "secure-note":
				isValid = secureNoteFormRef.current?.isValid() ?? false;
				break;
			case "totp":
				isValid = totpFormRef.current?.isValid() ?? false;
				if (!isValid) {
					Alert.alert("Error", "Please enter a valid TOTP secret key");
					return;
				}
				break;
		}

		if (!isValid) {
			return;
		}

		setSaving(true);

		try {
			// Build the data object based on category
			let itemData: DecryptedItemData = {
				title,
				notes: notes || undefined,
				tags: tags.length > 0 ? tags : undefined,
				customFields: customFields.length > 0 ? customFields : undefined,
			};

			switch (item.category) {
				case "login":
					itemData = { ...itemData, ...loginFormRef.current?.getData() };
					break;
				case "credit-card":
					itemData = { ...itemData, ...creditCardFormRef.current?.getData() };
					break;
				case "identity":
					itemData = { ...itemData, ...identityFormRef.current?.getData() };
					break;
				case "secure-note":
					itemData = {
						...itemData,
						...secureNoteFormRef.current?.getData(),
						notes: undefined, // Secure notes use 'note' field
					};
					break;
				case "totp":
					itemData = { ...itemData, ...totpFormRef.current?.getData() };
					break;
			}

			// Update the item using shared hook (handles encryption internally)
			await updateItem.mutateAsync({
				itemId,
				vaultId,
				data: itemData,
			});

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
				<Button onPress={() => router.back()} variant="primary" className="mt-4">
					Go Back
				</Button>
			</SafeAreaView>
		);
	}

	const categoryLabel =
		categoryOptions.find((c) => c.value === item.category)?.label ||
		"Unknown";

	return (
		<SafeAreaView className="flex-1 bg-background">
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
					<ItemIcon
						category={item.category}
						url={item.category === "login" ? item.url : undefined}
						size="md"
						className="mr-3"
					/>
					<View className="flex-1">
						<Text
							className="font-bold text-foreground text-xl"
							numberOfLines={1}
							ellipsizeMode="tail"
						>
							{item.title || "Untitled"}
						</Text>
						<Text className="text-muted-foreground text-sm">
							{categoryLabel}
						</Text>
					</View>
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
					{/* Title */}
					<TextField className="my-4" isRequired>
						<TextField.Label>Title</TextField.Label>
						<TextField.Input
							placeholder="Enter title"
							value={title}
							onChangeText={setTitle}
						/>
					</TextField>

					{/* Category-specific forms */}
					{item.category === "login" && initialized && (
						<LoginForm
							ref={loginFormRef}
							initialData={{
								username: item.username,
								password: item.password,
								url: item.url,
								urls: item.urls,
							}}
						/>
					)}
					{item.category === "credit-card" && initialized && (
						<CreditCardForm
							ref={creditCardFormRef}
							initialData={{
								cardholderName: item.cardholderName,
								cardNumber: item.cardNumber,
								expiryDate: item.expiryDate,
								cvv: item.cvv,
								billingAddress: item.billingAddress,
							}}
						/>
					)}
					{item.category === "identity" && initialized && (
						<IdentityForm
							ref={identityFormRef}
							initialData={{
								firstName: item.firstName,
								lastName: item.lastName,
								email: item.email,
							}}
						/>
					)}
					{item.category === "secure-note" && initialized && (
						<SecureNoteForm
							ref={secureNoteFormRef}
							initialData={{
								note: item.note || item.notes,
							}}
						/>
					)}
					{item.category === "totp" && initialized && (
						<TotpForm
							ref={totpFormRef}
							initialData={{
								totpSecret: item.totpSecret,
								totpIssuer: item.totpIssuer,
								totpAccountName: item.totpAccountName,
								totpAlgorithm: item.totpAlgorithm,
								totpDigits: item.totpDigits,
								totpPeriod: item.totpPeriod,
							}}
						/>
					)}

					{/* Notes (for non-secure-note items) */}
					{item.category !== "secure-note" && (
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
