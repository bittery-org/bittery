import { useAllVaultKeys, useCreateItem } from "@bittery/core/hooks";
import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
	Button,
	Input,
	Label,
	Select,
	TextField,
	useToast,
} from "heroui-native";
import { ArrowLeft, ChevronDown, Vault } from "lucide-react-native";
import { useRef, useState } from "react";
import {
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
import { SafeAreaView } from "@/components/safe-area-view";
import { TagInput } from "@/components/tag-input";
import { VaultAvatar } from "@/components/vault-avatar";
import { categoryOptions as allCategoryOptions } from "@/constants/item-categories";

// Create styled icon components
const StyledArrowLeft = withUniwind(ArrowLeft);
const StyledVault = withUniwind(Vault);
const StyledChevronDown = withUniwind(ChevronDown);

// Filter out "all" option for item creation
const categoryOptions = allCategoryOptions.filter((opt) => opt.value !== "all");

export default function CreateItemScreen() {
	const router = useRouter();
	const { toast } = useToast();
	const { vaultId: vaultIdParam } = useLocalSearchParams<{
		vaultId?: string;
	}>();
	const createItem = useCreateItem();
	const {
		vaultKeys = [],
		isLoading: isLoadingVaults,
		isAllAccountsMode,
	} = useAllVaultKeys();

	// Vault selection state
	const [selectedVaultId, setSelectedVaultId] = useState<string | undefined>(
		vaultIdParam,
	);

	const [category, setCategory] = useState<
		{ value: ItemCategory; label: string } | undefined
	>({ value: "login", label: "Login" });
	const [title, setTitle] = useState("");
	const [notes, setNotes] = useState("");
	const [tags, setTags] = useState<string[]>([]);
	const [saving, setSaving] = useState(false);

	// Form refs
	const loginFormRef = useRef<LoginFormRef>(null);
	const creditCardFormRef = useRef<CreditCardFormRef>(null);
	const identityFormRef = useRef<IdentityFormRef>(null);
	const secureNoteFormRef = useRef<SecureNoteFormRef>(null);
	const totpFormRef = useRef<TotpFormRef>(null);

	const handleSave = async () => {
		if (!title.trim()) {
			toast.show({
				variant: "danger",
				label: "Title is required",
				placement: "bottom",
			});
			return;
		}

		if (!selectedVaultId) {
			toast.show({
				variant: "danger",
				label: "Please select a vault",
				placement: "bottom",
			});
			return;
		}

		const categoryValue = category?.value || "login";

		// Validate category-specific forms
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
						label: "Please enter a valid TOTP secret key",
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
			// Build the data object based on category
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

			// Add notes if present
			if (notes.trim()) {
				itemData.notes = notes;
			}

			// Add tags if present
			if (tags.length > 0) {
				itemData.tags = tags;
			}

			// Create the item using shared hook (handles encryption internally)
			await createItem.mutateAsync({
				vaultId: selectedVaultId,
				category: categoryValue,
				data: itemData,
				accountEmail: selectedVault?.accountEmail,
			});

			toast.show({
				variant: "success",
				label: "Item created successfully",
				placement: "bottom",
			});
			router.back();
		} catch (error) {
			console.error("Error creating item:", error);
			toast.show({
				variant: "danger",
				label: error instanceof Error ? error.message : "Failed to create item",
				placement: "bottom",
			});
		} finally {
			setSaving(false);
		}
	};

	const selectedVault = vaultKeys.find((v) => v.vaultId === selectedVaultId);
	const selectedCategoryOption = categoryOptions.find(
		(opt) => opt.value === category?.value,
	);
	const getVaultLabel = (vault?: (typeof vaultKeys)[number]) => {
		if (!vault) return "";
		if (isAllAccountsMode && vault.accountEmail) {
			const accountLabel = vault.accountName || vault.accountEmail;
			return `${vault.vaultName} • ${accountLabel}`;
		}
		return vault.vaultName;
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
									? {
											value: selectedVaultId,
											label: getVaultLabel(selectedVault),
										}
									: undefined
							}
							onValueChange={(option) => {
								setSelectedVaultId(option?.value);
							}}
							isDisabled={isLoadingVaults || !!vaultIdParam}
						>
							<Select.Trigger asChild>
								<Button
									variant="secondary"
									size="md"
									className="w-full justify-start"
								>
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
										{selectedVault
											? getVaultLabel(selectedVault)
											: "Select Vault"}
									</Button.Label>
									<StyledChevronDown size={16} className="text-muted" />
								</Button>
							</Select.Trigger>
							<Select.Portal>
								<Select.Overlay />
								<Select.Content
									presentation="popover"
									width="trigger"
									className="h-62.5 rounded-2xl"
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
													<View className="flex-1">
														<Text className="text-base text-foreground">
															{vault.vaultName}
														</Text>
														{isAllAccountsMode && vault.accountEmail && (
															<Text className="text-muted text-xs">
																{vault.accountName || vault.accountEmail}
															</Text>
														)}
													</View>
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
								<Button
									variant="tertiary"
									size="md"
									className="w-full justify-start"
								>
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
									className="h-70 rounded-2xl"
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
						<Label>Title</Label>
						<Input
							placeholder="Enter title"
							value={title}
							onChangeText={setTitle}
						/>
					</TextField>

					{/* Category-specific forms */}
					{category?.value === "login" && <LoginForm ref={loginFormRef} />}
					{category?.value === "credit-card" && (
						<CreditCardForm ref={creditCardFormRef} />
					)}
					{category?.value === "identity" && (
						<IdentityForm ref={identityFormRef} />
					)}
					{category?.value === "secure-note" && (
						<SecureNoteForm ref={secureNoteFormRef} />
					)}
					{category?.value === "totp" && (
						<TotpForm ref={totpFormRef} onTitleAutoFill={setTitle} />
					)}

					{/* Tags */}
					<TagInput
						tags={tags}
						onTagsChange={setTags}
						placeholder="Add a tag..."
						label="Tags (optional)"
					/>

					{/* Notes (for non-secure-note items) */}
					{category?.value !== "secure-note" && (
						<TextField className="mb-4">
							<Label>Notes (optional)</Label>
							<Input
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
