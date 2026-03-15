import type { CreateVaultInput } from "@bittery/core/hooks";
import { useI18n } from "@bittery/i18n/react";
import { useForm } from "@tanstack/react-form";
import { useCallback, useRef, useState } from "react";
import { Button } from "../button";
import { cn } from "../../lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../dialog";
import { Input } from "../input";
import { Label } from "../label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../select";
import { toast } from "../sonner";
import {
	IconImagePlusOutlineDuo18,
	IconUserOutlineDuo18,
	IconUsers6OutlineDuo18,
	IconXmarkOutlineDuo18,
} from "../../icons";
import { VaultAvatar, vaultIconOptions } from "../vault-avatar";

export interface AccountOption {
	email: string;
	name?: string;
	teamName?: string;
}

interface CreateVaultDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSubmit: (data: CreateVaultInput) => Promise<void>;
	accounts?: AccountOption[];
}

export function CreateVaultDialog({
	open,
	onOpenChange,
	onSubmit,
	accounts,
}: CreateVaultDialogProps) {
	const defaultAccountEmail = accounts?.[0]?.email;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{open ? (
				<CreateVaultDialogForm
					key={`${open ? "open" : "closed"}:${defaultAccountEmail ?? "none"}`}
					onOpenChange={onOpenChange}
					onSubmit={onSubmit}
					accounts={accounts}
					defaultAccountEmail={defaultAccountEmail}
				/>
			) : null}
		</Dialog>
	);
}

function CreateVaultDialogForm({
	onOpenChange,
	onSubmit,
	accounts,
	defaultAccountEmail,
}: Omit<CreateVaultDialogProps, "open"> & {
	defaultAccountEmail?: string;
}) {
	const { m } = useI18n();
	const [icon, setIcon] = useState("lock");
	const [imageFile, setImageFile] = useState<File | undefined>(undefined);
	const [imagePreview, setImagePreview] = useState<string | null>(null);
	const [isDragging, setIsDragging] = useState(false);
	const [selectedAccountEmail, setSelectedAccountEmail] = useState<
		string | undefined
	>(defaultAccountEmail);
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
			name: "",
			type: "personal" as "personal" | "team",
		},
		onSubmit: async ({ value }) => {
			try {
				await onSubmit({
					name: value.name,
					type: value.type,
					icon,
					imageFile,
					accountEmail: accounts ? selectedAccountEmail : undefined,
				});
				resetForm();
				onOpenChange(false);
				toast.success(m.vaults_create_dialog_toast_created());
			} catch {
				toast.error(m.vaults_create_dialog_toast_create_failed());
			}
		},
	});

	const resetForm = () => {
		form.reset();
		setIcon("lock");
		setImageFile(undefined);
		updateImagePreview(null);
		setSelectedAccountEmail(defaultAccountEmail);
	};

	const processFile = useCallback(
		(file: File | undefined) => {
			if (!file) {
				setImageFile(undefined);
				updateImagePreview(null);
				return false;
			}

			if (!file.type.startsWith("image/")) {
				toast.error(m.vaults_create_dialog_toast_invalid_image_file());
				return false;
			}

			if (file.size > 2 * 1024 * 1024) {
				toast.error(m.vaults_create_dialog_toast_image_too_large());
				return false;
			}

			setImageFile(file);
			updateImagePreview(URL.createObjectURL(file));
			return true;
		},
		[
			m.vaults_create_dialog_toast_image_too_large,
			m.vaults_create_dialog_toast_invalid_image_file,
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

	return (
		<DialogContent className="sm:max-w-105" data-testid="create-vault-dialog">
			<DialogHeader>
				<DialogTitle>{m.vaults_create_dialog_title()}</DialogTitle>
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
							// biome-ignore lint/a11y/useKeyWithClickEvents: TODO
							// biome-ignore lint/a11y/noStaticElementInteractions: TODO
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
									name={name || m.vaults_create_dialog_avatar_fallback()}
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
								setImageFile(undefined);
								updateImagePreview(null);
							}}
							className="h-7 gap-1.5 text-muted-foreground text-xs"
						>
							<IconXmarkOutlineDuo18 className="size-3" />
							{m.vaults_create_dialog_image_action_remove()}
						</Button>
					) : (
						<p className="text-muted-foreground text-xs">
							{m.vaults_create_dialog_image_help()}
						</p>
					)}
				</div>

				{/* Icon Picker */}
				<div className="space-y-2">
					<Label className="text-muted-foreground text-xs">
						{m.vaults_create_dialog_field_icon()}
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

				{/* Account Selector (multi-account mode) */}
				{accounts && accounts.length > 0 && (
					<div className="space-y-2">
						<Label htmlFor="account" className="text-muted-foreground text-xs">
							{m.vaults_create_dialog_field_account()}
						</Label>
						<Select
							value={selectedAccountEmail}
							onValueChange={setSelectedAccountEmail}
							disabled={form.state.isSubmitting}
						>
							<SelectTrigger id="account" className="h-10">
								<SelectValue
									placeholder={m.vaults_create_dialog_placeholder_account()}
								/>
							</SelectTrigger>
							<SelectContent>
								{accounts.map((account) => (
									<SelectItem key={account.email} value={account.email}>
										<div className="flex flex-col">
											<span className="font-medium">
												{account.teamName || account.name || account.email}
											</span>
											<span className="text-muted-foreground text-xs">
												{account.email}
											</span>
										</div>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				)}

				{/* Vault Name */}
				<form.Field name="name">
					{(field) => (
						<div className="space-y-2">
							<Label
								htmlFor={field.name}
								className="text-muted-foreground text-xs"
							>
								{m.vaults_create_dialog_field_name()}
							</Label>
							<Input
								id={field.name}
								name={field.name}
								placeholder={m.vaults_create_dialog_placeholder_name()}
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

				{/* Vault Type */}
				<form.Field name="type">
					{(field) => (
						<div className="space-y-2">
							<Label className="text-muted-foreground text-xs">
								{m.vaults_create_dialog_field_type()}
							</Label>
							<div className="grid grid-cols-2 gap-2">
								<button
									type="button"
									onClick={() => field.handleChange("personal")}
									disabled={form.state.isSubmitting}
									className={cn(
										"flex",
										"items-center",
										"justify-center",
										"gap-2",
										"rounded-lg",
										"border-2",
										"px-4",
										"py-3",
										"font-medium",
										"text-sm",
										"transition-all",
										field.state.value === "personal"
											? "border-primary bg-primary/5 text-primary"
											: "border-border bg-background text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
									)}
								>
									<IconUserOutlineDuo18 className="size-4" />
									{m.vaults_create_dialog_type_personal()}
								</button>
								<button
									type="button"
									onClick={() => field.handleChange("team")}
									disabled={form.state.isSubmitting}
									className={cn(
										"flex",
										"items-center",
										"justify-center",
										"gap-2",
										"rounded-lg",
										"border-2",
										"px-4",
										"py-3",
										"font-medium",
										"text-sm",
										"transition-all",
										field.state.value === "team"
											? "border-primary bg-primary/5 text-primary"
											: "border-border bg-background text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
									)}
								>
									<IconUsers6OutlineDuo18 className="size-4" />
									{m.vaults_create_dialog_type_team()}
								</button>
							</div>
						</div>
					)}
				</form.Field>

				{/* Actions */}
				<div className="flex gap-2 pt-2">
					<Button
						type="button"
						variant="outline"
						onClick={() => {
							onOpenChange(false);
							resetForm();
						}}
						disabled={form.state.isSubmitting}
						className="flex-1"
						data-testid="create-vault-cancel-button"
					>
						{m.vaults_create_dialog_action_cancel()}
					</Button>
					<Button
						type="submit"
						disabled={form.state.isSubmitting}
						className="flex-1"
						data-testid="create-vault-submit-button"
					>
						{form.state.isSubmitting
							? m.vaults_create_dialog_action_creating()
							: m.vaults_create_dialog_action_submit()}
					</Button>
				</div>
			</form>
		</DialogContent>
	);
}
