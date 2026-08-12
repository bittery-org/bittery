import { useAllVaultKeys, useCreateItem } from "@bittery/core/hooks";
import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Input, Select, useToast } from "heroui-native";
import { useRef, useState } from "react";
import {
	KeyboardAvoidingView,
	Platform,
	Pressable,
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
import { FieldShell, FormField } from "@/components/item-forms/form-field";
import { TagInput } from "@/components/tag-input";
import {
	AppBar,
	BrandButton,
	IconChevronDown,
	IconVault,
	iconSize,
	layout,
	Screen,
	useBottomInset,
} from "@/components/ui";
import { VaultAvatar } from "@/components/vault-avatar";
import { getCategoryOptions } from "@/constants/item-categories";
import { useI18n } from "@/providers/i18n-provider";

export default function CreateItemScreen() {
	const { m } = useI18n();
	const router = useRouter();
	const { toast } = useToast();
	const bottomInset = useBottomInset({ extra: 0 });
	const { vaultId: vaultIdParam } = useLocalSearchParams<{
		vaultId?: string;
	}>();
	const createItem = useCreateItem();
	const { vaultKeys = [], isLoading: isLoadingVaults } = useAllVaultKeys();

	// "All categories" is a filter, never a shape an item can have.
	const categoryOptions = getCategoryOptions(m).filter(
		(option) => option.value !== "all",
	);

	const [selectedVaultId, setSelectedVaultId] = useState<string | undefined>(
		vaultIdParam,
	);
	const [category, setCategory] = useState<{
		value: ItemCategory;
		label: string;
	}>({ value: "login", label: m.mob_category_login() });
	const [title, setTitle] = useState("");
	const [notes, setNotes] = useState("");
	const [tags, setTags] = useState<string[]>([]);
	const [saving, setSaving] = useState(false);
	const [hasSubmitted, setHasSubmitted] = useState(false);

	const loginFormRef = useRef<LoginFormRef>(null);
	const creditCardFormRef = useRef<CreditCardFormRef>(null);
	const identityFormRef = useRef<IdentityFormRef>(null);
	const secureNoteFormRef = useRef<SecureNoteFormRef>(null);
	const totpFormRef = useRef<TotpFormRef>(null);

	const selectedVault = vaultKeys.find((v) => v.vaultId === selectedVaultId);
	const selectedCategoryOption = categoryOptions.find(
		(option) => option.value === category.value,
	);
	const titleError =
		hasSubmitted && !title.trim()
			? m.mob_create_item_toast_title_required()
			: null;
	const vaultError =
		hasSubmitted && !selectedVaultId
			? m.mob_create_item_toast_vault_required()
			: null;

	const handleSave = async () => {
		setHasSubmitted(true);

		if (!title.trim()) {
			toast.show({
				variant: "danger",
				label: m.mob_create_item_toast_title_required(),
				placement: "bottom",
			});
			return;
		}

		if (!selectedVaultId) {
			toast.show({
				variant: "danger",
				label: m.mob_create_item_toast_vault_required(),
				placement: "bottom",
			});
			return;
		}

		const categoryValue = category.value;

		let isValid = true;
		switch (categoryValue) {
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
						label: m.mob_create_item_toast_totp_invalid(),
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
			let itemData: DecryptedItemData = { title };

			switch (categoryValue) {
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
					itemData = { ...itemData, ...secureNoteFormRef.current?.getData() };
					break;
				case "totp":
					itemData = { ...itemData, ...totpFormRef.current?.getData() };
					break;
			}

			if (notes.trim()) {
				itemData.notes = notes;
			}

			if (tags.length > 0) {
				itemData.tags = tags;
			}

			// Encryption happens inside the hook — nothing plaintext leaves this screen.
			// No account hint: the vault coordinator derives the account from the vault.
			await createItem.mutateAsync({
				vaultId: selectedVaultId,
				category: categoryValue,
				data: itemData,
			});

			toast.show({
				variant: "success",
				label: m.mob_create_item_toast_success(),
				placement: "bottom",
			});
			router.back();
		} catch (error) {
			console.error("Error creating item:", error);
			toast.show({
				variant: "danger",
				label:
					error instanceof Error
						? error.message
						: m.mob_create_item_toast_failed(),
				placement: "bottom",
			});
		} finally {
			setSaving(false);
		}
	};

	return (
		<Screen>
			<AppBar showBack title={m.mob_create_item_header()} bordered />
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
					<FieldShell
						label={m.mob_create_item_vault_label()}
						error={vaultError}
					>
						<Select
							value={
								selectedVaultId
									? {
											value: selectedVaultId,
											label: selectedVault?.vaultName ?? "",
										}
									: undefined
							}
							onValueChange={(option) => setSelectedVaultId(option?.value)}
							isDisabled={isLoadingVaults || !!vaultIdParam}
						>
							<Select.Trigger asChild>
								<Pressable
									accessibilityRole="button"
									accessibilityLabel={m.mob_create_item_vault_label()}
									className="h-12 w-full flex-row items-center gap-3 rounded-xl border border-border bg-surface px-3"
								>
									{selectedVault ? (
										<VaultAvatar
											name={selectedVault.vaultName}
											icon={selectedVault.vaultIcon}
											imageUrl={selectedVault.vaultImageUrl}
											size="sm"
										/>
									) : (
										<IconVault size={iconSize.bar} className="text-muted" />
									)}
									<Text
										numberOfLines={1}
										className="min-w-0 flex-1 text-base text-foreground"
									>
										{selectedVault?.vaultName ??
											m.mob_create_item_vault_placeholder()}
									</Text>
									<IconChevronDown
										size={iconSize.chip}
										className="text-muted"
									/>
								</Pressable>
							</Select.Trigger>
							<Select.Portal>
								<Select.Overlay />
								<Select.Content
									presentation="popover"
									width="trigger"
									className="h-62.5 rounded-2xl bg-surface-secondary"
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
													<Text
														numberOfLines={1}
														className="min-w-0 flex-1 text-base text-foreground"
													>
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
					</FieldShell>

					<FieldShell label={m.mob_create_item_category_label()}>
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
								<Pressable
									accessibilityRole="button"
									accessibilityLabel={m.mob_create_item_category_label()}
									className="h-12 w-full flex-row items-center gap-3 rounded-xl border border-border bg-surface px-3"
								>
									{selectedCategoryOption ? (
										<selectedCategoryOption.icon
											size={iconSize.bar}
											className="text-muted"
										/>
									) : null}
									<Text
										numberOfLines={1}
										className="min-w-0 flex-1 text-base text-foreground"
									>
										{selectedCategoryOption?.label ??
											m.mob_create_item_category_placeholder()}
									</Text>
									<IconChevronDown
										size={iconSize.chip}
										className="text-muted"
									/>
								</Pressable>
							</Select.Trigger>
							<Select.Portal>
								<Select.Overlay />
								<Select.Content
									presentation="popover"
									width="trigger"
									className="h-70 rounded-2xl bg-surface-secondary"
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
														<Icon size={iconSize.row} className="text-muted" />
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
					</FieldShell>

					<FormField
						label={m.mob_create_item_title_label()}
						isRequired
						error={titleError}
					>
						<Input
							placeholder={m.mob_create_item_title_placeholder()}
							value={title}
							onChangeText={setTitle}
						/>
					</FormField>

					{category.value === "login" ? <LoginForm ref={loginFormRef} /> : null}
					{category.value === "credit-card" ? (
						<CreditCardForm ref={creditCardFormRef} />
					) : null}
					{category.value === "identity" ? (
						<IdentityForm ref={identityFormRef} />
					) : null}
					{category.value === "secure-note" ? (
						<SecureNoteForm ref={secureNoteFormRef} />
					) : null}
					{category.value === "totp" ? (
						<TotpForm ref={totpFormRef} onTitleAutoFill={setTitle} />
					) : null}

					<TagInput
						tags={tags}
						onTagsChange={setTags}
						placeholder={m.mob_create_item_tags_placeholder()}
					/>

					{category.value !== "secure-note" ? (
						<FormField label={m.mob_create_item_notes_label()}>
							<Input
								placeholder={m.mob_create_item_notes_placeholder()}
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
						label={
							saving ? m.mob_create_item_saving() : m.mob_create_item_save()
						}
						onPress={handleSave}
						isLoading={saving}
					/>
				</View>
			</KeyboardAvoidingView>
		</Screen>
	);
}
