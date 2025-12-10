import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff, LockIcon } from "lucide-react";
import { useState, useEffect } from "react";
import { toast } from "@bittery/ui";
import { Button } from "@bittery/ui";
import { Card } from "@bittery/ui";
import { Input } from "@bittery/ui";
import { Label } from "@bittery/ui";

export function UnlockPage() {
	const navigate = useNavigate();
	const [showPassword, setShowPassword] = useState(false);
	const [email, setEmail] = useState("");

	useEffect(() => {
		// Get stored session data for display
		chrome.runtime.sendMessage({ type: "GET_SESSION_DATA" }).then((response) => {
			if (response.sessionData) {
				setEmail(response.sessionData.email);
			}
		});
	}, []);

	const form = useForm({
		defaultValues: {
			password: "",
		},
		onSubmit: async ({ value }) => {
			await unlockMutation.mutateAsync(value);
		},
	});

	const unlockMutation = useMutation({
		mutationFn: async (values: { password: string }) => {
			// Send to background worker for quick unlock
			const response = await chrome.runtime.sendMessage({
				type: "QUICK_UNLOCK",
				payload: { password: values.password },
			});

			if (!response.success) {
				throw new Error(response.error || "Unlock failed");
			}

			return response;
		},
		onSuccess: () => {
			toast.success("Unlocked successfully!");
			navigate({ to: "/vault" });
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to unlock");
		},
	});

	const handleFullLogin = () => {
		navigate({ to: "/login" });
	};

	return (
		<div className="flex min-h-[400px] items-center justify-center p-4">
			<div className="w-full space-y-4">
				<div className="flex flex-col space-y-2 text-center">
					<h1 className="font-semibold text-xl tracking-tight">Welcome back</h1>
					<p className="text-muted-foreground text-sm">
						Enter your password to unlock your vault
					</p>
				</div>

				<Card className="border-0 bg-transparent p-8 shadow-none sm:border sm:bg-card sm:shadow-sm">
					<div className="rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-950/30">
						<div className="flex items-center gap-3">
							<div>
								<LockIcon className="text-blue-900 dark:text-blue-100" />
							</div>
							<div>
								<p className="font-medium text-blue-900 text-sm dark:text-blue-100">
									Quick Unlock Available
								</p>
							</div>
						</div>
					</div>

					<form
						onSubmit={(e) => {
							e.preventDefault();
							e.stopPropagation();
							form.handleSubmit();
						}}
						className="space-y-4"
					>
						<div>
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
												onBlur={field.handleBlur}
												onChange={(e) => field.handleChange(e.target.value)}
												required
												autoFocus
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
						</div>

						<Button
							type="submit"
							className="h-10 w-full font-medium"
							disabled={unlockMutation.isPending}
						>
							{unlockMutation.isPending ? "Unlocking..." : "Unlock Vault"}
						</Button>

						<Button
							type="button"
							variant="link"
							onClick={handleFullLogin}
							className="w-full text-muted-foreground"
						>
							Sign in with a different account
						</Button>
					</form>
				</Card>
			</div>
		</div>
	);
}
