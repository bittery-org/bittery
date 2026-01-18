import { Button, Card, Input, Label, toast } from "@bittery/ui";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff, LockIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function UnlockPage() {
	const navigate = useNavigate();
	const [showPassword, setShowPassword] = useState(false);
	const [_email, setEmail] = useState("");
	const [biometricAvailable, setBiometricAvailable] = useState(false);
	const [checkingBiometric, setCheckingBiometric] = useState(true);
	const [biometricAttempted, setBiometricAttempted] = useState(false);
	const hasAttemptedBiometric = useRef(false);

	// Define mutations first before they're used in useEffect
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

	const biometricUnlockMutation = useMutation({
		mutationFn: async () => {
			// Send to background worker for native biometric unlock
			const response = await chrome.runtime.sendMessage({
				type: "NATIVE_BIOMETRIC_UNLOCK",
			});

			if (!response.success) {
				throw new Error(response.error || "Biometric unlock failed");
			}

			return response;
		},
		onSuccess: () => {
			toast.success("Unlocked with biometric!");
			navigate({ to: "/vault" });
		},
		onError: (error: Error) => {
			toast.error(error.message || "Biometric unlock failed");
		},
	});

	// Initialize biometric check
	useEffect(() => {
		// Get stored session data for display
		chrome.runtime
			.sendMessage({ type: "GET_SESSION_DATA" })
			.then((response) => {
				if (response.sessionData) {
					setEmail(response.sessionData.email);
				}
			})
			.catch((error) => {
				console.error("Failed to get session data:", error);
			});

		// Check if native biometric is available
		chrome.runtime
			.sendMessage({ type: "CHECK_NATIVE_BIOMETRIC" })
			.then((response) => {
				console.log("Biometric check response:", response);

				const available =
					response.available && response.enabled && response.appRunning;
				setBiometricAvailable(available);
				setCheckingBiometric(false);

				// Automatically trigger biometric unlock if available (only once)
				if (available && !hasAttemptedBiometric.current) {
					hasAttemptedBiometric.current = true;
					setBiometricAttempted(true);
					// Use a small delay to ensure everything is initialized
					setTimeout(() => {
						biometricUnlockMutation.mutate();
					}, 100);
				}
			})
			.catch((error) => {
				console.error("Failed to check biometric:", error);
				setBiometricAvailable(false);
				setCheckingBiometric(false);
			});
	}, [biometricUnlockMutation]);

	const form = useForm({
		defaultValues: {
			password: "",
		},
		onSubmit: async ({ value }) => {
			await unlockMutation.mutateAsync(value);
		},
	});

	const handleFullLogin = () => {
		navigate({ to: "/login" });
	};

	return (
		<div className="flex min-h-[400px] items-center justify-center p-4">
			<div className="w-full max-w-sm space-y-4">
				<div className="flex flex-col space-y-2 text-center">
					<h1 className="font-semibold text-xl tracking-tight">Welcome back</h1>
					<p className="text-muted-foreground text-sm">
						{biometricUnlockMutation.isPending
							? "Authenticating with biometric..."
							: "Enter your password to unlock your vault"}
					</p>
				</div>

				<Card className="border-0 bg-transparent p-8 shadow-none sm:border sm:bg-card sm:shadow-sm">
					{!biometricUnlockMutation.isPending && (
						<div className="rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-950/30">
							<div className="flex items-center gap-3">
								<div>
									<LockIcon className="text-blue-900 dark:text-blue-100" />
								</div>
								<div>
									<p className="font-medium text-blue-900 text-sm dark:text-blue-100">
										Quick Unlock Available
									</p>
									{biometricAttempted && (
										<p className="text-blue-800 text-xs dark:text-blue-200">
											Or use password below
										</p>
									)}
								</div>
							</div>
						</div>
					)}

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
												className="-translate-y-1/2 absolute top-1/2 right-0 size-10 text-muted-foreground hover:text-foreground"
												onClick={() => setShowPassword(!showPassword)}
											>
												{showPassword ? (
													<EyeOff size={16} />
												) : (
													<Eye size={16} />
												)}
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
