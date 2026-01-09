import { Button, Card, Input, Label, toast } from "@bittery/ui";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";

export function LoginPage() {
	const navigate = useNavigate();
	const [showPassword, setShowPassword] = useState(false);
	const [showSecretKey, setShowSecretKey] = useState(false);

	const form = useForm({
		defaultValues: {
			email: "",
			password: "",
			secretKey: "",
		},
		onSubmit: async ({ value }) => {
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
		<div className="flex min-h-[400px] items-center justify-center p-4">
			<div className="w-full max-w-sm space-y-4">
				<div className="flex flex-col space-y-2 text-center">
					<h1 className="font-semibold text-xl tracking-tight">
						Sign in to your account
					</h1>
					<p className="text-muted-foreground text-sm">
						Enter your details below to access your vault
					</p>
				</div>

				<Card className="border-0 bg-transparent p-8 shadow-none sm:border sm:bg-card sm:shadow-sm">
					<form
						onSubmit={(e) => {
							e.preventDefault();
							form.handleSubmit();
						}}
						className="space-y-4"
					>
						<form.Field name="email">
							{(field) => (
								<div className="space-y-2">
									<Label htmlFor={field.name}>Email</Label>
									<Input
										id={field.name}
										name={field.name}
										type="email"
										placeholder="name@example.com"
										value={field.state.value}
										onChange={(e) => field.handleChange(e.target.value)}
										required
									/>
								</div>
							)}
						</form.Field>

						<form.Field name="password">
							{(field) => (
								<div className="space-y-2">
									<Label htmlFor={field.name}>Password</Label>
									<div className="relative">
										<Input
											id={field.name}
											name={field.name}
											type={showPassword ? "text" : "password"}
											placeholder="••••••••"
											value={field.state.value}
											onChange={(e) => field.handleChange(e.target.value)}
											required
										/>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="absolute top-0 right-0 h-full"
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
									<Label htmlFor={field.name}>Secret Key</Label>
									<div className="relative">
										<Input
											id={field.name}
											name={field.name}
											type={showSecretKey ? "text" : "password"}
											placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
											value={field.state.value}
											onChange={(e) => field.handleChange(e.target.value)}
											required
										/>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="absolute top-0 right-0 h-full"
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
							className="w-full"
							disabled={loginMutation.isPending}
						>
							{loginMutation.isPending ? "Signing in..." : "Sign in"}
						</Button>
					</form>
				</Card>
			</div>
		</div>
	);
}
