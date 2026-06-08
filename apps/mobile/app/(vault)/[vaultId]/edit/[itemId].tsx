import { useUpdateItem, useVaultItems } from "@bittery/core/hooks";
import type {
	CustomField,
	DecryptedItem,
	DecryptedItemData,
	ItemCategory,
} from "@bittery/shared/types";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, Input, Label, TextField, useToast } from "heroui-native";
import {
	ArrowLeft,
	CreditCard,
	FileText,
	Key,
	Timer,
	User,
} from "lucide-react-native";
import { useRef, useState } from "react";
import {
	ActivityIndicator,
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
import { TagInput } from "@/components/tag-input";
import { useI18n } from "@/providers/i18n-provider";

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
	const { m } = useI18n();
	const router = useRouter();
	const { vaultId, itemId } = useLocalSearchParams<{
		vaultId: string;
		itemId: string;
	}>();
	const updateItem = useUpdateItem();

	const { items, isLoading } = useVaultItems(vaultId);
	const item = items.find((i) => i.id === itemId);

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
				<Text className="text-foreground">{m.mob_edit_item_not_found()}</Text>
				<Button
					onPress={() => router.back()}
					variant="primary"
					className="mt-4"
				>
					{m.mob_edit_item_go_back()}
				</Button>
			</SafeAreaView>
		);
	}

	const categoryLabel =
		categoryOptions.find((c) => c.value === item.category)?.label || "Unknown";

	return (
		<EditItemForm
			key={item.id}
			item={item}
			itemId={itemId}
			vaultId={vaultId}
			categoryLabel={categoryLabel}
			onBack={() => router.back()}
			onSaved={() => router.back()}
			updateItem={updateItem}
		/>
	);
}

function EditItemForm({
	item,
	itemId,
	vaultId,
	categoryLabel,
	onBack,
	onSaved,
	updateItem,
}: {
	item: DecryptedItem;
	itemId: string;
	vaultId: string;
	categoryLabel: string;
	onBack: () => void;
	onSaved: () => void;
	updateItem: ReturnType<typeof useUpdateItem>;
}) {
	const { m } = useI18n();
	const { toast } = useToast();
	const [saving, setSaving] = useState(false);
	const [title, setTitle] = useState(item.title || "");
	const [notes, setNotes] = useState(item.notes || "");
	const [tags, setTags] = useState<string[]>(item.tags || []);
	const [customFields] = useState<CustomField[]>(item.customFields || []);
	const loginFormRef = useRef<LoginFormRef>(null);
	const creditCardFormRef = useRef<CreditCardFormRef>(null);
	const identityFormRef = useRef<IdentityFormRef>(null);
	const secureNoteFormRef = useRef<SecureNoteFormRef>(null);
	const totpFormRef = useRef<TotpFormRef>(null);

	const handleSave = async () => {
		if (!title.trim()) {
			toast.show({
				variant: "danger",
				label: m.mob_edit_item_toast_title_required(),
				placement: "bottom",
			});
			return;
		}

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
					toast.show({
						variant: "danger",
						label: m.mob_edit_item_toast_totp_invalid(),
						placement: "bottom",
					});
					return;
				}
				break;
		}

		if (!isValid) {
			return;
		}

		setSaving(true);

		try {
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
						notes: undefined,
					};
					break;
				case "totp":
					itemData = { ...itemData, ...totpFormRef.current?.getData() };
					break;
			}

			await updateItem.mutateAsync({
				itemId,
				vaultId,
				data: itemData,
			});

			toast.show({
				variant: "success",
				label: m.mob_edit_item_toast_success(),
				placement: "bottom",
			});
			onSaved();
		} catch (error) {
			console.error("Error updating item:", error);
			toast.show({
				variant: "danger",
				label:
					error instanceof Error
						? error.message
						: m.mob_edit_item_toast_failed(),
				placement: "bottom",
			});
		} finally {
			setSaving(false);
		}
	};

	return (
		<SafeAreaView className="flex-1 bg-background">
			<KeyboardAvoidingView
				behavior={Platform.OS === "ios" ? "padding" : "height"}
				className="flex-1"
			>
				{/* Header */}
				<View className="flex-row items-center px-4 py-4">
					<Button
						isIconOnly
						onPress={onBack}
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
							{item.title || m.mob_edit_item_untitled()}
						</Text>
						<Text className="text-muted text-sm">{categoryLabel}</Text>
					</View>
					<Button
						onPress={handleSave}
						isDisabled={saving}
						variant="primary"
						size="sm"
					>
						{saving ? m.mob_edit_item_saving() : m.mob_edit_item_save()}
					</Button>
				</View>

				<ScrollView className="flex-1 px-4" keyboardShouldPersistTaps="handled">
					{/* Title */}
					<TextField className="my-4" isRequired>
						<Label>{m.mob_edit_item_title_label()}</Label>
						<Input
							placeholder={m.mob_edit_item_title_placeholder()}
							value={title}
							onChangeText={setTitle}
						/>
					</TextField>

					{/* Category-specific forms */}
					{item.category === "login" && (
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
					{item.category === "credit-card" && (
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
					{item.category === "identity" && (
						<IdentityForm
							ref={identityFormRef}
							initialData={{
								firstName: item.firstName,
								lastName: item.lastName,
								email: item.email,
							}}
						/>
					)}
					{item.category === "secure-note" && (
						<SecureNoteForm
							ref={secureNoteFormRef}
							initialData={{
								note: item.note || item.notes,
							}}
						/>
					)}
					{item.category === "totp" && (
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

					{/* Tags */}
					<TagInput
						tags={tags}
						onTagsChange={setTags}
						placeholder={m.mob_edit_item_tags_placeholder()}
						label="Tags (optional)"
					/>

					{/* Notes (for non-secure-note items) */}
					{item.category !== "secure-note" && (
						<TextField className="mb-4">
							<Label>{m.mob_edit_item_notes_label()}</Label>
							<Input
								placeholder={m.mob_edit_item_notes_placeholder()}
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
