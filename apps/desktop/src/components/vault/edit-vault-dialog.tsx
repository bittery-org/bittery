import {
	Button,
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	Input,
	Label,
	toast,
} from "@bittery/ui";
import { useForm } from "@tanstack/react-form";
import { ImagePlus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { VaultAvatar, vaultIconOptions } from "./vault-avatar";

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
	const [icon, setIcon] = useState(vault?.icon || "lock");
	const [imageFile, setImageFile] = useState<File | undefined>(undefined);
	const [imagePreview, setImagePreview] = useState<string | null>(
		vault?.imageUrl || null,
	);
	const [removeImage, setRemoveImage] = useState(false);
	const [isDragging, setIsDragging] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// Reset state when vault changes
	useEffect(() => {
		if (vault) {
			setIcon(vault.icon || "lock");
			setImagePreview(vault.imageUrl || null);
			setImageFile(undefined);
			setRemoveImage(false);
		}
	}, [vault]);

	const form = useForm({
		defaultValues: {
			name: vault?.name || "",
		},
		onSubmit: async ({ value }) => {
			if (!vault) return;

			try {
				await onSubmit(vault.id, {
					name: value.name,
					icon,
					imageFile,
					removeImage,
				});
				onOpenChange(false);
				toast.success("Vault updated successfully");
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Failed to update vault";
				toast.error(errorMessage);
			}
		},
	});

	// Reset form when vault changes
	useEffect(() => {
		if (vault) {
			form.reset();
			form.setFieldValue("name", vault.name);
		}
	}, [vault, form]);

	// Cleanup blob URLs on unmount
	useEffect(() => {
		return () => {
			if (imagePreview?.startsWith("blob:")) {
				URL.revokeObjectURL(imagePreview);
			}
		};
	}, [imagePreview]);

	const processFile = useCallback((file: File | undefined) => {
		if (!file) return false;

		if (!file.type.startsWith("image/")) {
			toast.error("Please select an image file");
			return false;
		}

		if (file.size > 2 * 1024 * 1024) {
			toast.error("Image must be smaller than 2MB");
			return false;
		}

		setImageFile(file);
		setImagePreview(URL.createObjectURL(file));
		setRemoveImage(false);
		return true;
	}, []);

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
		setImagePreview(null);
		setRemoveImage(true);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[420px]">
				<DialogHeader>
					<DialogTitle>Edit Vault</DialogTitle>
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
								<div
									className={`relative cursor-pointer rounded-xl p-1 transition-all ${
										isDragging
											? "ring-2 ring-primary ring-offset-2"
											: "hover:ring-2 hover:ring-muted hover:ring-offset-2"
									}`}
									onDrop={handleDrop}
									onDragOver={handleDragOver}
									onDragLeave={handleDragLeave}
									onClick={() => fileInputRef.current?.click()}
								>
									<VaultAvatar
										name={name || "Vault"}
										icon={icon}
										imageUrl={imagePreview}
										size="xl"
									/>
									<div className="absolute -right-1 -bottom-1 rounded-full bg-primary p-1.5 text-primary-foreground shadow-sm">
										<ImagePlus className="size-3.5" />
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
								<X className="size-3" />
								Remove image
							</Button>
						) : (
							<p className="text-muted-foreground text-xs">
								Click or drag to upload
							</p>
						)}
					</div>

					{/* Icon Picker */}
					<div className="space-y-2">
						<Label className="text-muted-foreground text-xs">Icon</Label>
						<div className="flex flex-wrap justify-center gap-1.5">
							{vaultIconOptions.map((option) => (
								<button
									key={option.value}
									type="button"
									onClick={() => setIcon(option.value)}
									disabled={form.state.isSubmitting}
									className={`flex size-9 items-center justify-center rounded-lg transition-all ${
										icon === option.value
											? "bg-primary text-primary-foreground shadow-sm"
											: "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
									}`}
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
									Name
								</Label>
								<Input
									id={field.name}
									name={field.name}
									placeholder="Enter vault name"
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
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={form.state.isSubmitting}
							className="flex-1"
						>
							{form.state.isSubmitting ? "Saving..." : "Save Changes"}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
