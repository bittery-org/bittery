import { normalizeServerUrl } from "@bittery/shared/server-url";
import { Button, Card, Input, Label, toast, VaultIcon } from "@bittery/ui";
import {
	IconArrowLeftOutlineDuo18,
	IconEyeOutlineDuo18,
	IconEyeSlashOutlineDuo18,
} from "@bittery/ui/icons";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { storage } from "../lib/storage";
import { useI18n } from "../providers/i18n-provider";

export function LoginPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { m } = useI18n();
	const { addingAccount } = useSearch({ from: "/login" });
	const [showPassword, setShowPassword] = useState(false);
	const [showSecretKey, setShowSecretKey] = useState(false);
	const fallbackServerUrl =
		normalizeServerUrl("http://localhost:3000") ?? "http://localhost:3000";
	const [serverUrl, setServerUrl] = useState(fallbackServerUrl);

	useEffect(() => {
		let active = true;
		storage.getServerUrl().then((stored) => {
			if (!active || !stored) return;
			setServerUrl(stored);
		});
		return () => {
			active = false;
		};
	}, []);

	const persistServerUrl = async () => {
		const normalized = normalizeServerUrl(serverUrl);
		if (!normalized) {
			toast.error(m.ext_login_toast_invalid_server_url());
			return null;
		}
		if (normalized !== serverUrl) {
			setServerUrl(normalized);
		}
		return normalized;
	};

	const form = useForm({
		defaultValues: {
			email: "",
			password: "",
			secretKey: "",
		},
		onSubmit: async ({ value }) => {
			const persisted = await persistServerUrl();
			if (!persisted) {
				return;
			}
			await loginMutation.mutateAsync(value);
		},
	});

	const loginMutation = useMutation({
		mutationFn: async (values: {
			email: string;
			password: string;
			secretKey: string;
		}) => {
			// Send to background worker for crypto operations
			const response = await chrome.runtime.sendMessage({
				type: "LOGIN",
				payload: values,
			});

			if (!response.success) {
				throw new Error(response.error || m.ext_login_toast_failed());
			}

			return response;
		},
		onSuccess: async () => {
			// Refresh accounts queries to pick up the new account
			await queryClient.invalidateQueries({ queryKey: ["accounts"] });

			toast.success(
				addingAccount
					? m.ext_login_toast_account_added()
					: m.ext_login_toast_signed_in(),
			);
			navigate({ to: "/vault" });
		},
		onError: (error: Error) => {
			toast.error(error.message || m.ext_login_toast_failed());
		},
	});

	const handleBackToVault = () => {
		navigate({ to: "/vault" });
	};

	return (
		<div className="h-full overflow-y-auto">
			<div className="flex min-h-full justify-center p-4">
				<div className="my-auto w-full max-w-sm space-y-6">
					{addingAccount && (
						<Button
							variant="ghost"
							onClick={handleBackToVault}
							className="absolute top-4 left-4"
						>
							<IconArrowLeftOutlineDuo18 className="mr-2 size-4" />
							Back
						</Button>
					)}
					<div className="flex flex-col items-center space-y-3 text-center">
						<div style={{ width: 80, height: 80 }}>
							<VaultIcon state="locked" size={80} />
						</div>
						<div>
							<h1 className="font-semibold text-xl tracking-tight">
								{addingAccount
									? m.ext_login_title_add_account()
									: m.ext_login_title_sign_in()}
							</h1>
							<p className="mt-1 text-muted-foreground text-sm">
								{m.ext_login_description()}
							</p>
						</div>
					</div>

					<Card className="border-0 bg-transparent p-6 shadow-none sm:border sm:bg-card sm:shadow-sm">
						<form
							onSubmit={(e) => {
								e.preventDefault();
								form.handleSubmit();
							}}
							className="space-y-4"
						>
							<div className="space-y-2">
								<Label htmlFor="serverUrl" className="font-medium text-sm">
									{m.ext_login_label_server_url()}
								</Label>
								<Input
									id="serverUrl"
									name="serverUrl"
									type="url"
									placeholder="https://your-server.com"
									value={serverUrl}
									onChange={(e) => setServerUrl(e.target.value)}
									required
									className="h-10"
								/>
								<p className="text-muted-foreground text-xs">
									{m.ext_login_server_url_hint()}
								</p>
							</div>

							<form.Field name="email">
								{(field) => (
									<div className="space-y-2">
										<Label htmlFor={field.name} className="font-medium text-sm">
											{m.auth_signin_label_email()}
										</Label>
										<Input
											id={field.name}
											name={field.name}
											type="email"
											placeholder="name@example.com"
											value={field.state.value}
											onChange={(e) => field.handleChange(e.target.value)}
											required
											className="h-10"
										/>
									</div>
								)}
							</form.Field>

							<form.Field name="password">
								{(field) => (
									<div className="space-y-2">
										<Label htmlFor={field.name} className="font-medium text-sm">
											{m.auth_signin_label_password()}
										</Label>
										<div className="relative">
											<Input
												id={field.name}
												name={field.name}
												type={showPassword ? "text" : "password"}
												placeholder="••••••••"
												value={field.state.value}
												onChange={(e) => field.handleChange(e.target.value)}
												required
												className="h-10 pr-10"
											/>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												className="absolute top-1/2 right-0 size-10 -translate-y-1/2 text-muted-foreground hover:text-foreground"
												onClick={() => setShowPassword(!showPassword)}
											>
												{showPassword ? (
													<IconEyeSlashOutlineDuo18 size={16} />
												) : (
													<IconEyeOutlineDuo18 size={16} />
												)}
											</Button>
										</div>
									</div>
								)}
							</form.Field>

							<form.Field name="secretKey">
								{(field) => (
									<div className="space-y-2">
										<Label htmlFor={field.name} className="font-medium text-sm">
											{m.auth_signin_label_secret_key()}
										</Label>
										<div className="relative">
											<Input
												id={field.name}
												name={field.name}
												type={showSecretKey ? "text" : "password"}
												placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
												value={field.state.value}
												onChange={(e) => field.handleChange(e.target.value)}
												required
												className="h-10 pr-10"
											/>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												className="absolute top-1/2 right-0 size-10 -translate-y-1/2 text-muted-foreground hover:text-foreground"
												onClick={() => setShowSecretKey(!showSecretKey)}
											>
												{showSecretKey ? (
													<IconEyeSlashOutlineDuo18 size={16} />
												) : (
													<IconEyeOutlineDuo18 size={16} />
												)}
											</Button>
										</div>
									</div>
								)}
							</form.Field>

							<Button
								type="submit"
								className="h-10 w-full font-medium"
								disabled={loginMutation.isPending}
							>
								{loginMutation.isPending
									? m.auth_signin_button_signing_in()
									: m.auth_signin_button_sign_in()}
							</Button>
						</form>
					</Card>
				</div>
			</div>
		</div>
	);
}
