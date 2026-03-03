import type { CreateVaultInput } from "@bittery/core/hooks";
import {
	Button,
	cn,
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	Input,
	Label,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	toast,
} from "@bittery/ui";
import {
	IconImagePlusOutlineDuo18,
	IconUserOutlineDuo18,
	IconUsers6OutlineDuo18,
	IconXmarkOutlineDuo18,
} from "@bittery/ui/icons";
import { useForm } from "@tanstack/react-form";
import { useCallback, useEffect, useRef, useState } from "react";
import { VaultAvatar, vaultIconOptions } from "./vault-avatar";

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
	const [icon, setIcon] = useState("lock");
	const [imageFile, setImageFile] = useState<File | undefined>(undefined);
	const [imagePreview, setImagePreview] = useState<string | null>(null);
	const [isDragging, setIsDragging] = useState(false);
	const [selectedAccountEmail, setSelectedAccountEmail] = useState<
		string | undefined
	>(accounts?.[0]?.email);
	const fileInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (accounts && accounts.length > 0 && !selectedAccountEmail) {
			setSelectedAccountEmail(accounts[0].email);
		}
	}, [accounts, selectedAccountEmail]);

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
				toast.success("Vault created successfully");
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Failed to create vault";
				toast.error(errorMessage);
			}
		},
	});

	useEffect(() => {
		return () => {
			if (imagePreview) {
				URL.revokeObjectURL(imagePreview);
			}
		};
	}, [imagePreview]);

	const resetForm = () => {
		form.reset();
		setIcon("lock");
		setImageFile(undefined);
		setImagePreview(null);
		setSelectedAccountEmail(accounts?.[0]?.email);
	};

	const processFile = useCallback((file: File | undefined) => {
		if (!file) {
			setImageFile(undefined);
			setImagePreview(null);
			return false;
		}

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

	return (
		<Dialog
			open={open}
			onOpenChange={(newOpen) => {
				onOpenChange(newOpen);
				if (!newOpen) resetForm();
			}}
		>
			<DialogContent className="sm:max-w-105" data-testid="create-vault-dialog">
				<DialogHeader>
					<DialogTitle>Create New Vault</DialogTitle>
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
										name={name || "Vault"}
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
									setImagePreview(null);
								}}
								className="h-7 gap-1.5 text-muted-foreground text-xs"
							>
								<IconXmarkOutlineDuo18 className="size-3" />
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
							<Label
								htmlFor="account"
								className="text-muted-foreground text-xs"
							>
								Account
							</Label>
							<Select
								value={selectedAccountEmail}
								onValueChange={setSelectedAccountEmail}
								disabled={form.state.isSubmitting}
							>
								<SelectTrigger id="account" className="h-10">
									<SelectValue placeholder="Select account" />
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

					{/* Vault Type */}
					<form.Field name="type">
						{(field) => (
							<div className="space-y-2">
								<Label className="text-muted-foreground text-xs">Type</Label>
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
										Personal
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
										Team
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
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={form.state.isSubmitting}
							className="flex-1"
							data-testid="create-vault-submit-button"
						>
							{form.state.isSubmitting ? "Creating..." : "Create Vault"}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
