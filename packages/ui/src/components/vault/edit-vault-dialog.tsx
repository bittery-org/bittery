import { useI18n } from "@bittery/i18n/react";
import { useForm } from "@tanstack/react-form";
import { useCallback, useRef, useState } from "react";
import { Button } from "../button";
import { cn } from "../../lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../dialog";
import { Input } from "../input";
import { Label } from "../label";
import { toast } from "../sonner";
import {
	IconImagePlusOutlineDuo18,
	IconXmarkOutlineDuo18,
} from "../../icons";
import { VaultAvatar, vaultIconOptions } from "../vault-avatar";

export interface EditVaultData {
	id: string;
	name: string;
	icon?: string | null;
	imageUrl?: string | null;
}

export interface UpdateVaultData {
	name: string;
	icon?: string | null;
	imageFile?: File;
	removeImage?: boolean;
}

interface EditVaultDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	vault: EditVaultData | null;
	onSubmit: (vaultId: string, data: UpdateVaultData) => Promise<void>;
}

export function EditVaultDialog({
	open,
	onOpenChange,
	vault,
	onSubmit,
}: EditVaultDialogProps) {
	const dialogKey = vault ? `${vault.id}:${open ? "open" : "closed"}` : "empty";

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{open && vault ? (
				<EditVaultDialogForm
					key={dialogKey}
					onOpenChange={onOpenChange}
					vault={vault}
					onSubmit={onSubmit}
				/>
			) : null}
		</Dialog>
	);
}

function EditVaultDialogForm({
	onOpenChange,
	vault,
	onSubmit,
}: Omit<EditVaultDialogProps, "open"> & {
	vault: EditVaultData;
}) {
	const { m } = useI18n();
	const [icon, setIcon] = useState(vault?.icon || "lock");
	const [imageFile, setImageFile] = useState<File | undefined>(undefined);
	const [imagePreview, setImagePreview] = useState<string | null>(
		vault?.imageUrl || null,
	);
	const [removeImage, setRemoveImage] = useState(false);
	const [isDragging, setIsDragging] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const updateImagePreview = useCallback((nextPreview: string | null) => {
		setImagePreview((previousPreview) => {
			if (
				previousPreview?.startsWith("blob:") &&
				previousPreview !== nextPreview
			) {
				URL.revokeObjectURL(previousPreview);
			}
			return nextPreview;
		});
	}, []);

	const form = useForm({
		defaultValues: {
			name: vault?.name || "",
		},
		onSubmit: async ({ value }) => {
			try {
				await onSubmit(vault.id, {
					name: value.name,
					icon,
					imageFile,
					removeImage,
				});
				onOpenChange(false);
				toast.success(m.vaults_edit_dialog_toast_updated());
			} catch {
				toast.error(m.vaults_edit_dialog_toast_update_failed());
			}
		},
	});

	const processFile = useCallback(
		(file: File | undefined) => {
			if (!file) return false;

			if (!file.type.startsWith("image/")) {
				toast.error(m.vaults_edit_dialog_toast_invalid_image_file());
				return false;
			}

			if (file.size > 2 * 1024 * 1024) {
				toast.error(m.vaults_edit_dialog_toast_image_too_large());
				return false;
			}

			setImageFile(file);
			updateImagePreview(URL.createObjectURL(file));
			setRemoveImage(false);
			return true;
		},
		[
			m.vaults_edit_dialog_toast_image_too_large,
			m.vaults_edit_dialog_toast_invalid_image_file,
			updateImagePreview,
		],
	);

	const handleImageChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		if (!processFile(file)) {
			event.currentTarget.value = "";
		}
	};

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			setIsDragging(false);
			const file = e.dataTransfer.files[0];
			processFile(file);
		},
		[processFile],
	);

	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		setIsDragging(true);
	}, []);

	const handleDragLeave = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		setIsDragging(false);
	}, []);

	const handleRemoveImage = () => {
		setImageFile(undefined);
		updateImagePreview(null);
		setRemoveImage(true);
	};

	return (
		<DialogContent className="sm:max-w-105" data-testid="edit-vault-dialog">
			<DialogHeader>
				<DialogTitle>{m.vaults_edit_dialog_title()}</DialogTitle>
			</DialogHeader>

			<form
				onSubmit={(e) => {
					e.preventDefault();
					form.handleSubmit();
				}}
				className="space-y-5"
			>
				{/* Avatar Preview - Centered */}
				<div className="flex flex-col items-center gap-3 pt-2">
					<form.Subscribe selector={(state) => state.values.name}>
						{(name) => (
							// biome-ignore lint/a11y/noStaticElementInteractions: TODO
							// biome-ignore lint/a11y/useKeyWithClickEvents: TODO
							<div
								className={cn(
									"relative",
									"cursor-pointer",
									"rounded-xl",
									"p-1",
									"transition-all",
									isDragging
										? "ring-2 ring-primary ring-offset-2"
										: "hover:ring-2 hover:ring-muted hover:ring-offset-2",
								)}
								onDrop={handleDrop}
								onDragOver={handleDragOver}
								onDragLeave={handleDragLeave}
								onClick={() => fileInputRef.current?.click()}
							>
								<VaultAvatar
									name={name || m.vaults_edit_dialog_avatar_fallback()}
									icon={icon}
									imageUrl={imagePreview}
									size="xl"
								/>
								<div className="absolute -right-1 -bottom-1 rounded-full bg-primary p-1.5 text-primary-foreground shadow-sm">
									<IconImagePlusOutlineDuo18 className="size-3.5" />
								</div>
							</div>
						)}
					</form.Subscribe>
					<input
						ref={fileInputRef}
						type="file"
						accept="image/*"
						className="hidden"
						onChange={handleImageChange}
						disabled={form.state.isSubmitting}
					/>
					{imagePreview ? (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={(e) => {
								e.stopPropagation();
								handleRemoveImage();
							}}
							className="h-7 gap-1.5 text-muted-foreground text-xs"
						>
							<IconXmarkOutlineDuo18 className="size-3" />
							{m.vaults_edit_dialog_image_action_remove()}
						</Button>
					) : (
						<p className="text-muted-foreground text-xs">
							{m.vaults_edit_dialog_image_help()}
						</p>
					)}
				</div>

				{/* Icon Picker */}
				<div className="space-y-2">
					<Label className="text-muted-foreground text-xs">
						{m.vaults_edit_dialog_field_icon()}
					</Label>
					<div className="flex flex-wrap justify-center gap-1.5">
						{vaultIconOptions.map((option) => (
							<button
								key={option.value}
								type="button"
								onClick={() => setIcon(option.value)}
								disabled={form.state.isSubmitting}
								className={cn(
									"flex",
									"size-9",
									"items-center",
									"justify-center",
									"rounded-lg",
									"transition-all",
									icon === option.value
										? "bg-primary text-primary-foreground shadow-sm"
										: "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
								)}
								aria-label={option.label}
							>
								<option.Icon className="size-4" />
							</button>
						))}
					</div>
				</div>

				{/* Vault Name */}
				<form.Field name="name">
					{(field) => (
						<div className="space-y-2">
							<Label
								htmlFor={field.name}
								className="text-muted-foreground text-xs"
							>
								{m.vaults_edit_dialog_field_name()}
							</Label>
							<Input
								id={field.name}
								name={field.name}
								placeholder={m.vaults_edit_dialog_placeholder_name()}
								value={field.state.value}
								onBlur={field.handleBlur}
								onChange={(e) => field.handleChange(e.target.value)}
								disabled={form.state.isSubmitting}
								className="h-10"
								required
							/>
						</div>
					)}
				</form.Field>

				{/* Actions */}
				<div className="flex gap-2 pt-2">
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={form.state.isSubmitting}
						className="flex-1"
						data-testid="edit-vault-cancel-button"
					>
						{m.vaults_edit_dialog_action_cancel()}
					</Button>
					<Button
						type="submit"
						disabled={form.state.isSubmitting}
						className="flex-1"
						data-testid="edit-vault-submit-button"
					>
						{form.state.isSubmitting
							? m.vaults_edit_dialog_action_saving()
							: m.vaults_edit_dialog_action_submit()}
					</Button>
				</div>
			</form>
		</DialogContent>
	);
}
