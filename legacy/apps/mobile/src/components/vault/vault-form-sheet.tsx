/**
 * Creating and editing a vault, as one bottom sheet with two modes.
 *
 * There is no prior mobile art for this: `apps/mobile`'s Vaults tab answered "+" with a
 * "coming soon" toast (`apps/mobile/app/(tabs)/vaults.tsx`), so mobile has never been able to
 * make a vault at all. `@bittery/ui`'s `CreateVaultDialog` is 486 lines of desktop form —
 * drag-and-drop image upload, a hover ring, a `Select` for the account, `size-9` icon buttons —
 * so this is a mobile presentation over the same three hooks desktop uses (`useCreateVault`,
 * `useUpdateVault`, `useDeleteVault`) rather than a fork of that component.
 *
 * Kept identical to desktop on purpose: the icon set (`vaultIconOptions`), the 2MB image cap,
 * the `image/*` requirement, and the fact that a vault's *type* is fixed at creation — the
 * server has a separate conversion flow for changing it, which desktop does not expose either.
 */

import {
	type CreateVaultInput,
	useCreateVault,
	useUpdateVault,
} from "@bittery/core/hooks";
import { toast, VaultAvatar, vaultIconOptions } from "@bittery/ui";
import { IconImagePlus, IconUser, IconUsers, IconX } from "@bittery/ui/icons";
import { cn } from "@bittery/ui/lib/utils";
import { useState } from "react";
import {
	AccountAvatar,
	BrandButton,
	getAccountLabel,
	iconClass,
	ListCard,
	ListRow,
	MobileSheet,
	Pressable,
	SectionLabel,
	TextField,
} from "@/components/ui";
import { useAccount } from "@/contexts/account-context";
import { IMAGE_EXTENSIONS, type PickedFile, pickFile } from "@/lib/file-picker";
import { useI18n } from "@/providers/i18n-provider";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * The picked image, plus the object URL previewing it. They travel together because the URL
 * has to be revoked when the picture is replaced or dropped, and pairing them is what makes
 * that impossible to forget.
 */
interface PickedImage {
	file: PickedFile;
	previewUrl: string;
}

/** Shared by both modes: avatar preview, image picker, icon grid, name field. */
function VaultIdentityFields({
	name,
	onNameChange,
	icon,
	onIconChange,
	image,
	onImageChange,
	existingImageUrl,
	disabled,
}: {
	name: string;
	onNameChange: (next: string) => void;
	icon: string;
	onIconChange: (next: string) => void;
	image: PickedImage | null;
	onImageChange: (next: PickedImage | null) => void;
	existingImageUrl?: string | null;
	disabled: boolean;
}) {
	const { m } = useI18n();

	const handlePickImage = async () => {
		let picked: PickedFile | null;
		try {
			picked = await pickFile({ extensions: IMAGE_EXTENSIONS });
		} catch (error) {
			console.error("[vault-form] image pick failed", error);
			toast.error(m.mob_attachments_pick_failed());
			return;
		}
		if (!picked) return;

		// The extension filter is advisory on Android — SAF lets a user pick "all files" out of
		// some providers — so the type is re-checked here rather than trusted.
		if (!picked.type.startsWith("image/")) {
			toast.error(m.vaults_create_dialog_toast_invalid_image_file());
			return;
		}
		if (picked.size > MAX_IMAGE_BYTES) {
			toast.error(m.vaults_create_dialog_toast_image_too_large());
			return;
		}

		const bytes = await picked.arrayBuffer();
		onImageChange({
			file: picked,
			previewUrl: URL.createObjectURL(new Blob([bytes], { type: picked.type })),
		});
	};

	return (
		<>
			<div className="flex flex-col items-center gap-2">
				<Pressable
					onClick={() => void handlePickImage()}
					disabled={disabled}
					scale
					haptic={false}
					aria-label={m.mob_vault_form_image_action_pick()}
					className="relative rounded-2xl p-1"
				>
					<VaultAvatar
						name={name || m.vaults_create_dialog_avatar_fallback()}
						icon={icon}
						imageUrl={image?.previewUrl ?? existingImageUrl}
						size="xl"
					/>
					<span className="absolute -right-1 -bottom-1 rounded-full bg-primary p-1.5 text-primary-foreground shadow-surface">
						<IconImagePlus className="size-3.5" />
					</span>
				</Pressable>
				{/* Also offered when the vault already has a server image and none has been
				    picked — otherwise an existing picture could be replaced but never dropped. */}
				{image || existingImageUrl ? (
					<Pressable
						onClick={() => onImageChange(null)}
						disabled={disabled}
						className="flex h-8 items-center gap-1.5 rounded-full px-2 text-muted-foreground text-xs"
					>
						<IconX className="size-3" />
						{m.mob_vault_form_image_action_remove()}
					</Pressable>
				) : (
					<p className="text-muted-foreground text-xs">
						{m.mob_vault_form_image_hint()}
					</p>
				)}
			</div>

			<TextField
				label={m.vaults_create_dialog_field_name()}
				value={name}
				onChange={(event) => onNameChange(event.target.value)}
				placeholder={m.vaults_create_dialog_placeholder_name()}
				disabled={disabled}
				required
			/>

			<section>
				<SectionLabel>{m.vaults_create_dialog_field_icon()}</SectionLabel>
				{/* A wrapping grid, not a scrolling rail: there are 14 icons and all of them
				    should be reachable without a horizontal gesture inside a vertical sheet. */}
				<div className="grid grid-cols-7 gap-2">
					{vaultIconOptions.map((option) => {
						const isSelected = icon === option.value;
						return (
							<Pressable
								key={option.value}
								onClick={() => onIconChange(option.value)}
								disabled={disabled}
								aria-label={option.label}
								aria-pressed={isSelected}
								surface="sheet"
								className={cn(
									"flex aspect-square items-center justify-center rounded-xl",
									isSelected
										? "bg-primary text-primary-foreground"
										: "bg-surface-tertiary text-muted-foreground",
								)}
							>
								<option.Icon className={iconClass.bar} />
							</Pressable>
						);
					})}
				</div>
			</section>
		</>
	);
}

interface CreateVaultSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Called with the new vault's id once the server has it. */
	onCreated: (vaultId: string) => void;
}

export function CreateVaultSheet({
	open,
	onOpenChange,
	onCreated,
}: CreateVaultSheetProps) {
	const { m } = useI18n();
	const { activeAccount, allAccounts } = useAccount();
	const createVault = useCreateVault();

	const [name, setName] = useState("");
	const [icon, setIcon] = useState("lock");
	const [type, setType] = useState<CreateVaultInput["type"]>("personal");
	const [image, setImage] = useState<PickedImage | null>(null);
	const [accountId, setAccountId] = useState<string | null>(null);

	const selectedAccountId =
		accountId ?? activeAccount?.accountId ?? allAccounts[0]?.accountId ?? null;
	const isSubmitting = createVault.isPending;

	const replaceImage = (next: PickedImage | null) => {
		setImage((current) => {
			if (current) URL.revokeObjectURL(current.previewUrl);
			return next;
		});
	};

	const reset = () => {
		setName("");
		setIcon("lock");
		setType("personal");
		replaceImage(null);
		setAccountId(null);
	};

	const handleSubmit = async () => {
		const trimmedName = name.trim();
		if (!trimmedName || !selectedAccountId) return;

		try {
			const bytes = image ? await image.file.arrayBuffer() : undefined;
			const result = await createVault.mutateAsync({
				name: trimmedName,
				type,
				icon,
				// `createVault` reads `.type` and `.name` off whatever it is given, so a named
				// Blob satisfies it without a `File` constructor — which older Android WebViews
				// on the minSdk 24 floor do not all have.
				imageFile:
					bytes && image
						? Object.assign(new Blob([bytes], { type: image.file.type }), {
								name: image.file.name,
							})
						: undefined,
				accountId: selectedAccountId,
			});
			toast.success(m.vaults_create_dialog_toast_created());
			onOpenChange(false);
			setTimeout(reset, 220);
			onCreated(result.vaultId);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: m.vaults_create_dialog_toast_create_failed(),
			);
		}
	};

	return (
		<MobileSheet
			open={open}
			onOpenChange={(next) => {
				if (isSubmitting) return;
				onOpenChange(next);
				if (!next) setTimeout(reset, 220);
			}}
			title={m.mob_vault_create_title()}
			description={m.mob_vault_create_description()}
		>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void handleSubmit();
				}}
				className="flex flex-col gap-5 px-4 pt-1 pb-6"
			>
				<VaultIdentityFields
					name={name}
					onNameChange={setName}
					icon={icon}
					onIconChange={setIcon}
					image={image}
					onImageChange={replaceImage}
					disabled={isSubmitting}
				/>

				<section>
					<SectionLabel>{m.vaults_create_dialog_field_type()}</SectionLabel>
					<ListCard>
						<ListRow
							title={m.vaults_create_dialog_type_personal()}
							subtitle={m.mob_vault_form_type_personal_hint()}
							leading={
								<span
									className={cn(
										"flex size-10 items-center justify-center rounded-xl",
										type === "personal"
											? "bg-primary-soft text-primary"
											: "bg-surface-tertiary text-muted-foreground",
									)}
								>
									<IconUser className={iconClass.row} />
								</span>
							}
							isSelected={type === "personal"}
							isDisabled={isSubmitting}
							onPress={() => setType("personal")}
						/>
						<ListRow
							title={m.vaults_create_dialog_type_team()}
							subtitle={m.mob_vault_form_type_team_hint()}
							leading={
								<span
									className={cn(
										"flex size-10 items-center justify-center rounded-xl",
										type === "team"
											? "bg-primary-soft text-primary"
											: "bg-surface-tertiary text-muted-foreground",
									)}
								>
									<IconUsers className={iconClass.row} />
								</span>
							}
							isSelected={type === "team"}
							isDisabled={isSubmitting}
							onPress={() => setType("team")}
						/>
					</ListCard>
				</section>

				{/* A picker only when there is something to pick, matching desktop. */}
				{allAccounts.length > 1 ? (
					<section>
						<SectionLabel>
							{m.vaults_create_dialog_field_account()}
						</SectionLabel>
						<ListCard>
							{allAccounts.map((account) => (
								<ListRow
									key={account.accountId}
									title={getAccountLabel(
										account,
										m.mob_settings_account_fallback(),
									)}
									subtitle={account.email}
									leading={<AccountAvatar account={account} />}
									isSelected={account.accountId === selectedAccountId}
									isDisabled={isSubmitting}
									onPress={() => setAccountId(account.accountId)}
								/>
							))}
						</ListCard>
					</section>
				) : null}

				<div className="flex flex-col gap-2">
					<BrandButton
						label={
							isSubmitting
								? m.vaults_create_dialog_action_creating()
								: m.vaults_create_dialog_action_submit()
						}
						isLoading={isSubmitting}
						disabled={!name.trim() || !selectedAccountId}
						onClick={() => void handleSubmit()}
					/>
					<Pressable
						onClick={() => onOpenChange(false)}
						disabled={isSubmitting}
						surface="sheet"
						className="flex h-11 w-full items-center justify-center rounded-xl bg-surface-tertiary font-medium text-base text-foreground"
					>
						{m.vaults_create_dialog_action_cancel()}
					</Pressable>
				</div>
			</form>
		</MobileSheet>
	);
}

interface EditVaultSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	vault: {
		vaultId: string;
		vaultName: string;
		vaultIcon?: string | null;
		vaultImageUrl?: string | null;
		accountId: string;
	};
}

export function EditVaultSheet({
	open,
	onOpenChange,
	vault,
}: EditVaultSheetProps) {
	const { m } = useI18n();
	const updateVault = useUpdateVault();

	const [name, setName] = useState(vault.vaultName);
	const [icon, setIcon] = useState(vault.vaultIcon ?? "lock");
	const [image, setImage] = useState<PickedImage | null>(null);
	const [hasRemovedImage, setHasRemovedImage] = useState(false);

	const isSubmitting = updateVault.isPending;

	const replaceImage = (next: PickedImage | null) => {
		setImage((current) => {
			if (current) URL.revokeObjectURL(current.previewUrl);
			return next;
		});
		// Clearing the picked image on a vault that *has* a server image means "remove it",
		// not "go back to the server one" — there is no third state in the update contract.
		setHasRemovedImage(next === null && Boolean(vault.vaultImageUrl));
	};

	const handleSubmit = async () => {
		const trimmedName = name.trim();
		if (!trimmedName) return;

		try {
			const bytes = image ? await image.file.arrayBuffer() : undefined;
			await updateVault.mutateAsync({
				vaultId: vault.vaultId,
				name: trimmedName,
				icon,
				imageFile:
					bytes && image
						? (Object.assign(new Blob([bytes], { type: image.file.type }), {
								name: image.file.name,
							}) as unknown as File)
						: undefined,
				removeImage: hasRemovedImage,
				accountId: vault.accountId,
			});
			toast.success(m.vaults_edit_dialog_toast_updated());
			onOpenChange(false);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: m.vaults_edit_dialog_toast_update_failed(),
			);
		}
	};

	return (
		<MobileSheet
			open={open}
			onOpenChange={(next) => {
				if (isSubmitting) return;
				onOpenChange(next);
			}}
			title={m.mob_vault_edit_title()}
			description={m.mob_vault_edit_description()}
		>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void handleSubmit();
				}}
				className="flex flex-col gap-5 px-4 pt-1 pb-6"
			>
				<VaultIdentityFields
					name={name}
					onNameChange={setName}
					icon={icon}
					onIconChange={setIcon}
					image={image}
					onImageChange={replaceImage}
					existingImageUrl={hasRemovedImage ? null : vault.vaultImageUrl}
					disabled={isSubmitting}
				/>

				<div className="flex flex-col gap-2">
					<BrandButton
						label={
							isSubmitting
								? m.vaults_edit_dialog_action_saving()
								: m.vaults_edit_dialog_action_submit()
						}
						isLoading={isSubmitting}
						disabled={!name.trim()}
						onClick={() => void handleSubmit()}
					/>
					<Pressable
						onClick={() => onOpenChange(false)}
						disabled={isSubmitting}
						surface="sheet"
						className="flex h-11 w-full items-center justify-center rounded-xl bg-surface-tertiary font-medium text-base text-foreground"
					>
						{m.vaults_edit_dialog_action_cancel()}
					</Pressable>
				</div>
			</form>
		</MobileSheet>
	);
}
