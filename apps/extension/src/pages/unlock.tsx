import {
	Button,
	Card,
	Input,
	Label,
	toast,
	VaultIcon,
	type VaultIconState,
} from "@bittery/ui";
import {
	IconEyeOutlineDuo18,
	IconEyeSlashOutlineDuo18,
} from "@bittery/ui/icons";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { storage } from "../lib/storage";

export function UnlockPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [showPassword, setShowPassword] = useState(false);
	const [biometricAttempted, setBiometricAttempted] = useState(false);
	const [vaultState, setVaultState] = useState<VaultIconState>("locked");
	const hasAttemptedBiometric = useRef(false);

	// Get all accounts
	const { data: accounts = [] } = useQuery({
		queryKey: ["accounts", "list"],
		queryFn: () => storage.getAccountsList(),
	});

	// Check desktop sync status
	const { data: desktopStatus } = useQuery({
		queryKey: ["desktop-sync-status-unlock"],
		queryFn: async () => {
			try {
				const response = await chrome.runtime.sendMessage({
					type: "CHECK_DESKTOP_STATUS",
				});
				return response;
			} catch {
				return null;
			}
		},
		refetchInterval: 3000,
	});

	// Unlock all accounts with password
	const unlockMutation = useMutation({
		mutationFn: async (values: { password: string }) => {
			setVaultState("unlocking");
			// Send to background worker to unlock all accounts
			const response = await chrome.runtime.sendMessage({
				type: "QUICK_UNLOCK_ALL",
				payload: { password: values.password },
			});

			if (!response.success) {
				throw new Error(response.error || "Unlock failed");
			}

			return response;
		},
		onSuccess: async (response) => {
			// Refresh accounts queries
			await queryClient.invalidateQueries({ queryKey: ["accounts"] });

			setVaultState("unlocked");

			const { unlocked = [], failed = [] } = response.result || {};
			if (failed.length === 0) {
				if (accounts.length === 1) {
					toast.success("Vault unlocked");
				} else {
					toast.success(`All ${unlocked.length} accounts unlocked`);
				}
			} else {
				toast.warning(
					`Unlocked ${unlocked.length} of ${accounts.length} accounts`,
				);
			}

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

	// Biometric unlock all accounts
	const biometricUnlockMutation = useMutation({
		mutationFn: async () => {
			setVaultState("unlocking");
			// Send to background worker for native biometric unlock
			const response = await chrome.runtime.sendMessage({
				type: "NATIVE_BIOMETRIC_UNLOCK_ALL",
			});

			if (!response.success) {
				throw new Error(response.error || "Biometric unlock failed");
			}

			return response;
		},
		onSuccess: async (response) => {
			// Refresh accounts queries (including unlocked status)
			await queryClient.invalidateQueries({ queryKey: ["accounts"] });

			setVaultState("unlocked");

			const { unlocked = [], failed = [] } = response.result || {};
			if (failed.length === 0) {
				if (accounts.length === 1) {
					toast.success("Unlocked with biometric");
				} else {
					toast.success(`All ${unlocked.length} accounts unlocked`);
				}
			} else {
				toast.warning(
					`Unlocked ${unlocked.length} of ${accounts.length} accounts`,
				);
			}

			// Delay navigation to show unlock animation
			setTimeout(() => {
				navigate({ to: "/vault" });
			}, 600);
		},
		onError: (error: Error) => {
			setVaultState("locked");
			// Don't show error toast if desktop is locked (user will unlock in desktop)
			if (!error.message?.includes("Desktop app is locked")) {
				toast.error(error.message || "Biometric unlock failed");
			}
		},
	});

	// Initialize biometric check
	useEffect(() => {
		if (accounts.length === 0) return;

		// Check if native biometric is available from desktop app
		chrome.runtime
			.sendMessage({ type: "CHECK_NATIVE_BIOMETRIC" })
			.then((response) => {
				const desktopAvailable =
					response.available && response.enabled && response.appRunning;

				// Automatically trigger biometric unlock if desktop app is available (only once)
				// The actual biometric unlock handler will check which accounts have biometric enabled
				if (desktopAvailable && !hasAttemptedBiometric.current) {
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
	}, [accounts.length, biometricUnlockMutation.mutate]);

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

	if (accounts.length === 0) {
		return (
			<div className="flex min-h-[400px] items-center justify-center p-4">
				<div className="text-center">
					<p className="text-gray-600">No accounts found</p>
					<Button onClick={handleFullLogin} className="mt-4">
						Sign In
					</Button>
				</div>
			</div>
		);
	}

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
						{accounts.length === 1 ? (
							<p className="mt-1 font-medium text-sm">{accounts[0]?.email}</p>
						) : (
							<p className="mt-1 text-muted-foreground text-sm">
								{accounts.length} accounts
							</p>
						)}
						<p className="mt-1 text-muted-foreground text-sm">
							{vaultState === "unlocking"
								? "Unlocking your vault..."
								: "Enter your password to unlock"}
						</p>
					</div>
				</div>

				<Card className="border-0 bg-transparent p-6 shadow-none sm:border sm:bg-card sm:shadow-sm">
					{/* Desktop app locked banner */}
					{desktopStatus?.success &&
						desktopStatus?.available &&
						desktopStatus?.locked && (
							<div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
								<p className="text-center text-amber-800 text-sm dark:text-amber-200">
									Desktop app is locked. Unlock in desktop app for best
									experience, or use password below for extension-only access.
								</p>
							</div>
						)}

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
													<IconEyeSlashOutlineDuo18 size={16} />
												) : (
													<IconEyeOutlineDuo18 size={16} />
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
							{unlockMutation.isPending
								? "Unlocking..."
								: accounts.length === 1
									? "Unlock Vault"
									: `Unlock All (${accounts.length})`}
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
