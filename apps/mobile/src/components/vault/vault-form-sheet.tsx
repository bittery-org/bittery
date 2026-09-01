/**
 * Editing a vault in a native bottom sheet.
 *
 * Native Vault creation stays absent until the later Runtime host slice, so this sheet only
 * edits an existing Vault's identity.
 */

import { useUpdateVault } from "@bittery/core/hooks";
import { toast, VaultAvatar, vaultIconOptions } from "@bittery/ui";
import { IconImagePlus, IconX } from "@bittery/ui/icons";
import { cn } from "@bittery/ui/lib/utils";
import { useState } from "react";
import {
	BrandButton,
	iconClass,
	MobileSheet,
	Pressable,
	SectionLabel,
	TextField,
} from "@/components/ui";
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

/** Identity fields shared by the existing-Vault edit flow. */
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
