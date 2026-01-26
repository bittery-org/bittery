import {
	Button,
	Card,
	Input,
	Label,
	toast,
	VaultIcon,
	type VaultIconState,
} from "@bittery/ui";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { storage } from "../lib/storage";

export function UnlockPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { email: emailParam } = useSearch({ from: "/unlock" });
	const [showPassword, setShowPassword] = useState(false);
	const [targetEmail, setTargetEmail] = useState<string | null>(null);
	const [biometricAttempted, setBiometricAttempted] = useState(false);
	const [vaultState, setVaultState] = useState<VaultIconState>("locked");
	const hasAttemptedBiometric = useRef(false);

	// Determine which account to unlock
	useEffect(() => {
		const determineTarget = async () => {
			if (emailParam) {
				setTargetEmail(emailParam);
				return;
			}

			// Fall back to active account
			const activeEmail = await storage.getActiveAccountEmail();
			if (activeEmail) {
				setTargetEmail(activeEmail);
			}
		};

		determineTarget();
	}, [emailParam]);

	// Define mutations first before they're used in useEffect
	const unlockMutation = useMutation({
		mutationFn: async (values: { password: string }) => {
			setVaultState("unlocking");
			// Send to background worker for quick unlock with target email
			const response = await chrome.runtime.sendMessage({
				type: "QUICK_UNLOCK",
				payload: { password: values.password, email: targetEmail },
			});

			if (!response.success) {
				throw new Error(response.error || "Unlock failed");
			}

			return response;
		},
		onSuccess: async () => {
			// Refresh accounts queries
			await queryClient.invalidateQueries({ queryKey: ["accounts"] });

			setVaultState("unlocked");
			toast.success("Unlocked successfully!");
			// Delay navigation to show unlock animation
			setTimeout(() => {
				navigate({ to: "/vault" });
			}, 600);
		},
		onError: (error: Error) => {
			setVaultState("locked");
			toast.error(error.message || "Failed to unlock");
		},
	});

	const biometricUnlockMutation = useMutation({
		mutationFn: async () => {
			setVaultState("unlocking");
			// Send to background worker for native biometric unlock with target email
			const response = await chrome.runtime.sendMessage({
				type: "NATIVE_BIOMETRIC_UNLOCK",
				payload: { email: targetEmail },
			});

			if (!response.success) {
				throw new Error(response.error || "Biometric unlock failed");
			}

			return response;
		},
		onSuccess: async () => {
			// Refresh accounts queries
			await queryClient.invalidateQueries({ queryKey: ["accounts"] });

			setVaultState("unlocked");
			toast.success("Unlocked with biometric!");
			// Delay navigation to show unlock animation
			setTimeout(() => {
				navigate({ to: "/vault" });
			}, 600);
		},
		onError: (error: Error) => {
			setVaultState("locked");
			toast.error(error.message || "Biometric unlock failed");
		},
	});

	// Initialize biometric check
	useEffect(() => {
		if (!targetEmail) return;

		// Check if native biometric is available
		chrome.runtime
			.sendMessage({ type: "CHECK_NATIVE_BIOMETRIC" })
			.then((response) => {
				console.log("Biometric check response:", response);

				const available =
					response.available && response.enabled && response.appRunning;

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
			});
	}, [targetEmail]);

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
				<div className="flex flex-col items-center space-y-3 text-center">
					<div style={{ width: 120, height: 120 }}>
						<VaultIcon state={vaultState} size={120} />
					</div>
					<div>
						<h1 className="font-semibold text-xl tracking-tight">
							Welcome back
						</h1>
						{targetEmail && (
							<p className="mt-1 font-medium text-sm">{targetEmail}</p>
						)}
						<p className="mt-1 text-muted-foreground text-sm">
							{vaultState === "unlocking"
								? "Unlocking your vault..."
								: "Enter your password to unlock"}
						</p>
					</div>
				</div>

				<Card className="border-0 bg-transparent p-6 shadow-none sm:border sm:bg-card sm:shadow-sm">
					{biometricAttempted && !biometricUnlockMutation.isPending && (
						<div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-950/30">
							<p className="text-center text-blue-800 text-sm dark:text-blue-200">
								Or use your password below
							</p>
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
												className="absolute top-1/2 right-0 size-10 -translate-y-1/2 text-muted-foreground hover:text-foreground"
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
