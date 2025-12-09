import { useForm } from "@tanstack/react-form";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { generatePassword } from "@/lib/crypto";

interface LoginFormData {
	title: string;
	url: string;
	username: string;
	password: string;
	notes: string;
}

interface SecureNoteFormData {
	title: string;
	note: string;
}

interface ItemFormProps {
	category: "login" | "secure-note";
	initialData?: Partial<LoginFormData | SecureNoteFormData>;
	onSubmit: (data: LoginFormData | SecureNoteFormData) => Promise<void> | void;
	onCancel: () => void;
	submitLabel?: string;
	isSubmitting?: boolean;
}

export function ItemForm(props: ItemFormProps) {
	if (props.category === "login") {
		return <LoginForm {...props} />;
	}
	return <SecureNoteForm {...props} />;
}

function LoginForm({
	initialData,
	onSubmit,
	onCancel,
	submitLabel = "Save",
	isSubmitting = false,
}: Omit<ItemFormProps, "category">) {
	const form = useForm({
		defaultValues: {
			title: (initialData as Partial<LoginFormData>)?.title || "",
			url: (initialData as Partial<LoginFormData>)?.url || "",
			username: (initialData as Partial<LoginFormData>)?.username || "",
			password: (initialData as Partial<LoginFormData>)?.password || "",
			notes: (initialData as Partial<LoginFormData>)?.notes || "",
		},
		onSubmit: async ({ value }) => {
			try {
				await onSubmit(value);
				toast.success("Item saved successfully");
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : "Failed to save item";
				toast.error(errorMessage);
			}
		},
	});

	const handleGeneratePassword = () => {
		const newPassword = generatePassword(20);
		form.setFieldValue("password", newPassword);
		toast.success("Password generated");
	};

	return (
		<form
				onSubmit={(e) => {
					e.preventDefault();
					form.handleSubmit();
				}}
				className="space-y-4"
			>
				<div>
					<form.Field name="title">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>Title *</Label>
								<Input
									id={field.name}
									name={field.name}
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="My Account"
									required
								/>
							</div>
						)}
					</form.Field>
				</div>

				<div>
					<form.Field name="url">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>Website</Label>
								<Input
									id={field.name}
									name={field.name}
									type="url"
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="https://example.com"
								/>
							</div>
						)}
					</form.Field>
				</div>

				<div>
					<form.Field name="username">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>Username</Label>
								<Input
									id={field.name}
									name={field.name}
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="user@example.com"
								/>
							</div>
						)}
					</form.Field>
				</div>

				<div>
					<form.Field name="password">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>Password</Label>
								<div className="flex gap-2">
									<Input
										id={field.name}
										name={field.name}
										type="password"
										value={field.state.value}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value)}
										placeholder="••••••••••"
										className="flex-1 font-mono"
									/>
									<Button
										type="button"
										variant="outline"
										size="icon"
										onClick={handleGeneratePassword}
										title="Generate Password"
									>
										<RefreshCw size={16} />
									</Button>
								</div>
							</div>
						)}
					</form.Field>
				</div>

				<div>
					<form.Field name="notes">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>Notes</Label>
								<textarea
									id={field.name}
									name={field.name}
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="Additional notes..."
									rows={4}
									className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
								/>
							</div>
						)}
					</form.Field>
				</div>

				<div className="flex gap-2 pt-4">
					<Button type="submit" className="flex-1" disabled={isSubmitting}>
						{isSubmitting ? "Saving..." : submitLabel}
					</Button>
					<Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
						Cancel
					</Button>
				</div>
			</form>
		);
}

function SecureNoteForm({
	initialData,
	onSubmit,
	onCancel,
	submitLabel = "Save",
	isSubmitting = false,
}: Omit<ItemFormProps, "category">) {
	const form = useForm({
		defaultValues: {
			title: (initialData as Partial<SecureNoteFormData>)?.title || "",
			note: (initialData as Partial<SecureNoteFormData>)?.note || "",
		},
		onSubmit: async ({ value }) => {
			try {
				await onSubmit(value);
				toast.success("Note saved successfully");
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : "Failed to save note";
				toast.error(errorMessage);
			}
		},
	});

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				form.handleSubmit();
			}}
			className="space-y-4"
		>
			<div>
				<form.Field name="title">
					{(field) => (
						<div className="space-y-2">
							<Label htmlFor={field.name}>Title *</Label>
							<Input
								id={field.name}
								name={field.name}
								value={field.state.value}
								onBlur={field.handleBlur}
								onChange={(e) => field.handleChange(e.target.value)}
								placeholder="My Secure Note"
								required
							/>
						</div>
					)}
				</form.Field>
			</div>

			<div>
				<form.Field name="note">
					{(field) => (
						<div className="space-y-2">
							<Label htmlFor={field.name}>Note Content *</Label>
							<textarea
								id={field.name}
								name={field.name}
								value={field.state.value}
								onBlur={field.handleBlur}
								onChange={(e) => field.handleChange(e.target.value)}
								placeholder="Write your secure note here..."
								rows={12}
								required
								className="flex min-h-[240px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
							/>
						</div>
					)}
				</form.Field>
			</div>

			<div className="flex gap-2 pt-4">
				<Button type="submit" className="flex-1" disabled={isSubmitting}>
					{isSubmitting ? "Saving..." : submitLabel}
				</Button>
				<Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
					Cancel
				</Button>
			</div>
		</form>
	);
}
