import { Button, toast, type VaultIconState } from "@bittery/ui";
import {
	IconEye,
	IconEyeOff,
	IconFingerprint,
	IconKey,
	IconLock,
	IconTriangleAlert,
} from "@bittery/ui/icons";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import iconMark from "../../icons/icon-128.png";
import { storage } from "../lib/storage";
import { useI18n } from "../providers/i18n-provider";

/** teamName → name → email initials, never a raw-email slice artifact. */
function getInitials(account: {
	teamName?: string;
	name: string;
	email: string;
}) {
	const source = account.teamName || account.name;
	if (source) {
		const parts = source.trim().split(/\s+/);
		if (parts.length >= 2) {
			return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
		}
		return source.slice(0, 2).toUpperCase();
	}
	return account.email.slice(0, 2).toUpperCase();
}

export function UnlockPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { m } = useI18n();
	const [showPassword, setShowPassword] = useState(false);
	const [biometricAvailable, setBiometricAvailable] = useState(false);
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
				throw new Error(response.error || m.ext_unlock_toast_failed());
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
					toast.success(m.toast_auth_unlock_success_single());
				} else {
					toast.success(
						m.ext_unlock_toast_unlocked_all({ count: unlocked.length }),
					);
				}
			} else {
				toast.warning(
					m.ext_unlock_toast_partial({
						unlockedCount: unlocked.length,
						totalCount: accounts.length,
					}),
				);
			}

			// Delay navigation to show unlock animation
			setTimeout(() => {
				navigate({ to: "/vault" });
			}, 600);
		},
		onError: (error: Error) => {
			setVaultState("locked");
			toast.error(error.message || m.ext_unlock_toast_failed());
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
				throw new Error(
					response.error || m.toast_auth_unlock_error_biometric_failed(),
				);
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
					toast.success(m.toast_auth_unlock_success_biometric_single());
				} else {
					toast.success(
						m.ext_unlock_toast_unlocked_all({ count: unlocked.length }),
					);
				}
			} else {
				toast.warning(
					m.ext_unlock_toast_partial({
						unlockedCount: unlocked.length,
						totalCount: accounts.length,
					}),
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
				toast.error(
					error.message || m.toast_auth_unlock_error_biometric_failed(),
				);
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

				setBiometricAvailable(Boolean(desktopAvailable));

				// Automatically trigger biometric unlock if desktop app is available (only once)
				// The actual biometric unlock handler will check which accounts have biometric enabled
				if (desktopAvailable && !hasAttemptedBiometric.current) {
					hasAttemptedBiometric.current = true;
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

	const handleOpenDesktopApp = async () => {
		try {
			const response = await chrome.runtime.sendMessage({
				type: "OPEN_DESKTOP_APP",
			});
			if (!response?.success) {
				throw new Error(response?.error);
			}
		} catch {
			toast.error(m.ext_vault_toast_desktop_open_failed());
		}
	};

	// Full-screen aurora wash at the top of the auth surface.
	const aurora = (
		<div
			aria-hidden
			className="pointer-events-none absolute inset-x-0 top-0 h-60 bg-[radial-gradient(70%_100%_at_50%_0%,color-mix(in_oklab,var(--color-primary-deep)_8%,transparent),transparent_70%)] dark:bg-[radial-gradient(70%_100%_at_50%_0%,color-mix(in_oklab,var(--color-primary-deep)_14%,transparent),transparent_70%)]"
		/>
	);

	const emblem = (
		<div
			aria-hidden
			className="mb-4 flex size-16 items-center justify-center [filter:drop-shadow(0_4px_14px_oklch(0_0_0/0.2))_drop-shadow(0_0_28px_color-mix(in_oklab,var(--color-primary-deep)_30%,transparent))] dark:[filter:drop-shadow(0_4px_14px_oklch(0_0_0/0.35))_drop-shadow(0_0_28px_color-mix(in_oklab,var(--color-primary-deep)_50%,transparent))]"
		>
			<img
				src={iconMark}
				alt=""
				className={`size-[58px] object-contain transition-transform duration-150 ${
					vaultState === "unlocking" ? "scale-[1.06]" : "scale-100"
				}`}
			/>
		</div>
	);

	if (accounts.length === 0) {
		return (
			<div className="relative flex min-h-[520px] flex-col items-center justify-center overflow-hidden p-6">
				{aurora}
				<div className="relative flex w-[300px] flex-col items-center text-center">
					{emblem}
					<h1 className="font-semibold text-base tracking-tight">
						{m.ext_unlock_title_vault_locked()}
					</h1>
					<p className="mt-1.5 mb-4 text-muted-foreground text-xs">
						{m.ext_unlock_no_accounts()}
					</p>
					<Button
						onClick={handleFullLogin}
						className="h-[34px] w-full rounded-lg"
					>
						{m.auth_signin_button_sign_in()}
					</Button>
				</div>
			</div>
		);
	}

	const isSingle = accounts.length === 1;
	const primaryAccount = accounts[0];
	const isPending = unlockMutation.isPending || vaultState === "unlocking";

	return (
		<div className="relative flex min-h-[520px] flex-col items-center justify-center overflow-hidden p-6">
			{aurora}
			<div className="relative flex w-[300px] flex-col items-center">
				{emblem}
				<h1 className="font-semibold text-base tracking-tight">
					{m.ext_unlock_title_vault_locked()}
				</h1>
				<div className="mt-1.5 mb-[18px] flex items-center gap-1.5 text-muted-foreground text-xs">
					{isSingle && primaryAccount ? (
						<>
							<span
								aria-hidden
								className="flex size-4 items-center justify-center rounded-[4.5px] bg-linear-to-br from-primary to-primary-deep font-semibold text-[7.5px] text-primary-foreground shadow-[inset_0_0_0_1px_oklch(1_0_0/0.18)]"
							>
								{getInitials(primaryAccount)}
							</span>
							<span className="max-w-[240px] truncate">
								{primaryAccount.email}
							</span>
						</>
					) : (
						<span>
							{m.ext_unlock_accounts_count({ count: accounts.length })}
						</span>
					)}
				</div>

				{/* Desktop app locked banner */}
				{desktopStatus?.success &&
					desktopStatus?.available &&
					desktopStatus?.locked && (
						<div className="mb-3.5 flex w-full items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/10 p-2.5 text-muted-foreground text-xs">
							<IconTriangleAlert className="mt-px size-3.5 shrink-0 text-warning" />
							<div>
								<span className="font-medium text-foreground">
									{m.ext_unlock_desktop_locked_lead()}
								</span>{" "}
								{m.ext_unlock_desktop_locked_body()}{" "}
								<button
									type="button"
									onClick={handleOpenDesktopApp}
									className="font-medium text-warning hover:underline"
								>
									{m.ext_unlock_open_desktop_app()}
								</button>
							</div>
						</div>
					)}

				<form
					onSubmit={(e) => {
						e.preventDefault();
						e.stopPropagation();
						form.handleSubmit();
					}}
					className="w-full"
				>
					<form.Field name="password">
						{(field) => (
							<div className="mb-2.5 flex h-[34px] items-center gap-2 rounded-lg border bg-transparent px-2.5 transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25 dark:bg-input/20">
								<IconKey className="size-3.5 shrink-0 text-muted-foreground" />
								<input
									id={field.name}
									name={field.name}
									// biome-ignore lint/a11y/noAutofocus: password field is the primary action on unlock
									autoFocus
									type={showPassword ? "text" : "password"}
									placeholder={m.ext_unlock_placeholder_master_password()}
									autoComplete="current-password"
									value={field.state.value}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									required
									className="min-w-0 flex-1 bg-transparent text-foreground text-sm outline-none placeholder:text-muted-foreground"
								/>
								<button
									type="button"
									onClick={() => setShowPassword(!showPassword)}
									className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
								>
									{showPassword ? (
										<IconEyeOff className="size-3.5" />
									) : (
										<IconEye className="size-3.5" />
									)}
								</button>
							</div>
						)}
					</form.Field>

					<Button
						type="submit"
						className="h-[34px] w-full rounded-lg"
						disabled={isPending}
					>
						<IconLock className="size-3.5" />
						{isPending
							? m.ext_unlock_button_unlocking()
							: isSingle
								? m.auth_signin_button_unlock_vault()
								: m.ext_unlock_button_unlock_all({ count: accounts.length })}
					</Button>

					{biometricAvailable && (
						<>
							<div className="my-3 flex items-center gap-2.5 font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
								<span aria-hidden className="h-px flex-1 bg-border" />
								{m.ext_unlock_or()}
								<span aria-hidden className="h-px flex-1 bg-border" />
							</div>
							<Button
								type="button"
								variant="outline"
								className="h-[34px] w-full rounded-lg"
								disabled={isPending}
								onClick={() => biometricUnlockMutation.mutate()}
							>
								<IconFingerprint className="size-4 text-primary" />
								{m.ext_unlock_touch_id()}
							</Button>
						</>
					)}
				</form>

				<div className="mt-3.5 text-center text-muted-foreground text-xs">
					{m.ext_unlock_not_you()}{" "}
					<button
						type="button"
						onClick={handleFullLogin}
						className="font-medium text-foreground/80 transition-colors hover:text-foreground"
					>
						{m.ext_unlock_use_different_account()}
					</button>
				</div>
			</div>
		</div>
	);
}
