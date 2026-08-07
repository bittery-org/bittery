import { useUpdateItem, useVaultItems } from "@bittery/core/hooks";
import type {
	CustomField,
	DecryptedItem,
	DecryptedItemData,
} from "@bittery/shared/types";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Input, useToast } from "heroui-native";
import { useRef, useState } from "react";
import {
	ActivityIndicator,
	KeyboardAvoidingView,
	Platform,
	ScrollView,
	Text,
	View,
} from "react-native";
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
import { FormField } from "@/components/item-forms/form-field";
import { TagInput } from "@/components/tag-input";
import {
	AppBar,
	BrandButton,
	EmptyState,
	IconSearch,
	layout,
	Screen,
	useBottomInset,
} from "@/components/ui";
import { getCategoryLabels } from "@/constants/item-categories";
import { useI18n } from "@/providers/i18n-provider";

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

	if (isLoading) {
		return (
			<Screen>
				<AppBar showBack />
				<View className="flex-1 items-center justify-center">
					<ActivityIndicator size="large" />
				</View>
			</Screen>
		);
	}

	if (!item) {
		return (
			<Screen>
				<AppBar showBack />
				<EmptyState
					icon={IconSearch}
					title={m.mob_edit_item_not_found()}
					actionLabel={m.mob_edit_item_go_back()}
					onAction={() => router.back()}
				/>
			</Screen>
		);
	}

	return (
		<EditItemForm
			key={item.id}
			item={item}
			itemId={itemId}
			vaultId={vaultId}
			categoryLabel={getCategoryLabels(m)[item.category]}
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
	const bottomInset = useBottomInset({ extra: 0 });
	const [saving, setSaving] = useState(false);
	const [title, setTitle] = useState(item.title || "");
	const [notes, setNotes] = useState(item.notes || "");
	const [tags, setTags] = useState<string[]>(item.tags || []);
	const [customFields] = useState<CustomField[]>(item.customFields || []);
	const [hasSubmitted, setHasSubmitted] = useState(false);
	const loginFormRef = useRef<LoginFormRef>(null);
	const creditCardFormRef = useRef<CreditCardFormRef>(null);
	const identityFormRef = useRef<IdentityFormRef>(null);
	const secureNoteFormRef = useRef<SecureNoteFormRef>(null);
	const totpFormRef = useRef<TotpFormRef>(null);

	const titleError =
		hasSubmitted && !title.trim()
			? m.mob_edit_item_toast_title_required()
			: null;

	const handleSave = async () => {
		setHasSubmitted(true);

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
		<Screen>
			<AppBar
				showBack
				onBack={onBack}
				title={item.title || m.mob_edit_item_untitled()}
				bordered
			/>
			<KeyboardAvoidingView
				behavior={Platform.OS === "ios" ? "padding" : "height"}
				className="flex-1"
			>
				<ScrollView
					className="flex-1"
					keyboardShouldPersistTaps="handled"
					contentContainerStyle={{
						paddingHorizontal: layout.screenPadding,
						paddingTop: layout.gap.md,
						paddingBottom: layout.gap.lg,
						gap: layout.gap.md,
					}}
				>
					<FormField
						label={m.mob_edit_item_title_label()}
						isRequired
						error={titleError}
						labelAccessory={
							<View className="rounded-lg bg-default px-2 py-0.5">
								<Text className="font-medium text-2xs text-muted">
									{categoryLabel}
								</Text>
							</View>
						}
					>
						<Input
							placeholder={m.mob_edit_item_title_placeholder()}
							value={title}
							onChangeText={setTitle}
						/>
					</FormField>

					{item.category === "login" ? (
						<LoginForm
							ref={loginFormRef}
							initialData={{
								username: item.username,
								password: item.password,
								url: item.url,
								urls: item.urls,
							}}
						/>
					) : null}
					{item.category === "credit-card" ? (
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
					) : null}
					{item.category === "identity" ? (
						<IdentityForm
							ref={identityFormRef}
							initialData={{
								firstName: item.firstName,
								lastName: item.lastName,
								email: item.email,
							}}
						/>
					) : null}
					{item.category === "secure-note" ? (
						<SecureNoteForm
							ref={secureNoteFormRef}
							initialData={{ note: item.note || item.notes }}
						/>
					) : null}
					{item.category === "totp" ? (
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
					) : null}

					<TagInput
						tags={tags}
						onTagsChange={setTags}
						placeholder={m.mob_edit_item_tags_placeholder()}
					/>

					{item.category !== "secure-note" ? (
						<FormField label={m.mob_edit_item_notes_label()}>
							<Input
								placeholder={m.mob_edit_item_notes_placeholder()}
								value={notes}
								onChangeText={setNotes}
								multiline
								numberOfLines={4}
								textAlignVertical="top"
								style={{ minHeight: 96 }}
							/>
						</FormField>
					) : null}
				</ScrollView>

				<View
					className="border-border border-t bg-background px-4 pt-3"
					style={{ paddingBottom: bottomInset + layout.gap.sm }}
				>
					<BrandButton
						label={saving ? m.mob_edit_item_saving() : m.mob_edit_item_save()}
						onPress={handleSave}
						isLoading={saving}
					/>
				</View>
			</KeyboardAvoidingView>
		</Screen>
	);
}
