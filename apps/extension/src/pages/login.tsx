import { normalizeServerUrl } from "@bittery/shared/server-url";
import { Button, Card, Input, Label, toast, VaultIcon } from "@bittery/ui";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import { storage } from "../lib/storage";

export function LoginPage() {
	const navigate = useNavigate();
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
			toast.error("Invalid server URL");
			return null;
		}
		await storage.storeServerUrl(normalized);
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
				throw new Error(response.error || "Login failed");
			}

			return response;
		},
		onSuccess: () => {
			toast.success("Signed in successfully!");
			navigate({ to: "/vault" });
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to sign in");
		},
	});

	return (
		<div className="h-full overflow-y-auto">
			<div className="flex min-h-full justify-center p-4">
				<div className="my-auto w-full max-w-sm space-y-6">
				<div className="flex flex-col items-center space-y-3 text-center">
					<div style={{ width: 80, height: 80 }}>
						<VaultIcon state="locked" size={80} />
					</div>
					<div>
						<h1 className="font-semibold text-xl tracking-tight">
							Sign in to Bittery
						</h1>
						<p className="mt-1 text-muted-foreground text-sm">
							Enter your credentials to access your vault
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
							<Label htmlFor="serverUrl" className="text-sm font-medium">
								Server URL
							</Label>
							<Input
								id="serverUrl"
								name="serverUrl"
								type="url"
								placeholder="https://your-server.com"
								value={serverUrl}
								onChange={(e) => setServerUrl(e.target.value)}
								onBlur={() => {
									persistServerUrl();
								}}
								required
								className="h-10"
							/>
							<p className="text-muted-foreground text-xs">
								Your self-hosted Bittery server URL
							</p>
						</div>

						<form.Field name="email">
							{(field) => (
								<div className="space-y-2">
									<Label htmlFor={field.name} className="text-sm font-medium">
										Email
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
									<Label htmlFor={field.name} className="text-sm font-medium">
										Password
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
											{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
										</Button>
									</div>
								</div>
							)}
						</form.Field>

						<form.Field name="secretKey">
							{(field) => (
								<div className="space-y-2">
									<Label htmlFor={field.name} className="text-sm font-medium">
										Secret Key
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
											{showSecretKey ? <EyeOff size={16} /> : <Eye size={16} />}
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
							{loginMutation.isPending ? "Signing in..." : "Sign in"}
						</Button>
					</form>
				</Card>
			</div>
		</div>
		</div>
	);
}
