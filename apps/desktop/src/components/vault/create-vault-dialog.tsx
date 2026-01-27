import type { CreateVaultInput } from "@bittery/hooks";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
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
import { useForm } from "@tanstack/react-form";
import { useEffect, useState } from "react";
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
	/** Optional list of accounts for multi-account mode. If provided, user must select account. */
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
	const [selectedAccountEmail, setSelectedAccountEmail] = useState<
		string | undefined
	>(accounts?.[0]?.email);

	// Update selected account when accounts list changes
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

	const handleImageChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0] || undefined;
		if (!file) {
			setImageFile(undefined);
			setImagePreview(null);
			return;
		}

		if (!file.type.startsWith("image/")) {
			toast.error("Please select an image file");
			event.currentTarget.value = "";
			setImageFile(undefined);
			setImagePreview(null);
			return;
		}

		if (file.size > 2 * 1024 * 1024) {
			toast.error("Image must be smaller than 2MB");
			event.currentTarget.value = "";
			setImageFile(undefined);
			setImagePreview(null);
			return;
		}

		setImageFile(file);
		setImagePreview(URL.createObjectURL(file));
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(newOpen) => {
				onOpenChange(newOpen);
				if (!newOpen) {
					resetForm();
				}
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Create New Vault</DialogTitle>
					<DialogDescription>
						Create a new vault to organize your passwords and secure notes.
					</DialogDescription>
				</DialogHeader>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						form.handleSubmit();
					}}
				>
					<div className="space-y-4 py-4">
						{accounts && accounts.length > 0 && (
							<div className="space-y-2">
								<Label htmlFor="account">Account *</Label>
								<Select
									value={selectedAccountEmail}
									onValueChange={setSelectedAccountEmail}
									disabled={form.state.isSubmitting}
								>
									<SelectTrigger id="account">
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

						<form.Field name="name">
							{(field) => (
								<div className="space-y-2">
									<Label htmlFor={field.name}>Vault Name *</Label>
									<Input
										id={field.name}
										name={field.name}
										placeholder="My Vault"
										value={field.state.value}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value)}
										disabled={form.state.isSubmitting}
										required
									/>
								</div>
							)}
						</form.Field>

						<form.Field name="type">
							{(field) => (
								<div className="space-y-2">
									<Label>Vault Type</Label>
									<div className="flex gap-2">
										<Button
											type="button"
											variant={
												field.state.value === "personal" ? "default" : "outline"
											}
											onClick={() => field.handleChange("personal")}
											disabled={form.state.isSubmitting}
											className="flex-1"
										>
											Personal
										</Button>
										<Button
											type="button"
											variant={
												field.state.value === "team" ? "default" : "outline"
											}
											onClick={() => field.handleChange("team")}
											disabled={form.state.isSubmitting}
											className="flex-1"
										>
											Team
										</Button>
									</div>
								</div>
							)}
						</form.Field>

						<div className="space-y-2">
							<Label>Appearance</Label>
							<div className="flex items-start gap-4">
								<form.Subscribe selector={(state) => state.values.name}>
									{(name) => (
										<VaultAvatar
											name={name || "Vault"}
											icon={icon}
											imageUrl={imagePreview}
											size="lg"
										/>
									)}
								</form.Subscribe>
								<div className="flex flex-1 flex-col gap-3">
									<div className="grid grid-cols-4 gap-2">
										{vaultIconOptions.map((option) => (
											<Button
												key={option.value}
												type="button"
												variant={icon === option.value ? "default" : "outline"}
												onClick={() => setIcon(option.value)}
												disabled={form.state.isSubmitting}
												size="sm"
												className="h-9 px-0"
												aria-label={option.label}
											>
												<option.Icon className="size-4" />
											</Button>
										))}
									</div>
									<div className="flex flex-col gap-2">
										<Input
											id="vault-image"
											type="file"
											accept="image/*"
											disabled={form.state.isSubmitting}
											onChange={handleImageChange}
										/>
										{imagePreview && (
											<Button
												type="button"
												variant="ghost"
												size="sm"
												onClick={() => {
													setImageFile(undefined);
													setImagePreview(null);
												}}
												disabled={form.state.isSubmitting}
												className="h-8 justify-start px-2 text-muted-foreground"
											>
												Remove custom image
											</Button>
										)}
										<p className="text-muted-foreground text-xs">
											Optional. PNG, JPG, or WebP up to 2MB.
										</p>
									</div>
								</div>
							</div>
						</div>
					</div>
					<div className="flex gap-2">
						<Button
							type="submit"
							disabled={form.state.isSubmitting}
							className="flex-1"
						>
							{form.state.isSubmitting ? "Creating..." : "Create Vault"}
						</Button>
						<Button
							type="button"
							variant="outline"
							onClick={() => {
								onOpenChange(false);
								resetForm();
							}}
							disabled={form.state.isSubmitting}
						>
							Cancel
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
