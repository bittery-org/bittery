import { useLogin } from "@bittery/core/hooks";
import { getAccountSessionManager } from "@bittery/core/services/account-session-manager";
import { normalizeServerUrl } from "@bittery/shared/server-url";
import {
	Button,
	Checkbox,
	Input,
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
	Label,
	toast,
} from "@bittery/ui";
import {
	IconEyeOutlineDuo18,
	IconEyeSlashOutlineDuo18,
	IconFingerprintOutlineDuo18,
} from "@bittery/ui/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AuthDoorsLayout } from "@/components/auth/auth-doors-layout";
import { triggerAuthRevealToVault } from "@/lib/auth-reveal-transition";
import {
	resolveActiveAuthServerUrl,
	setActiveAuthServerUrl,
	subscribeActiveAuthServerUrl,
} from "@/lib/auth-server";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

interface LoginSearchParams {
	prefillEmail?: string;
}

export const Route = createFileRoute("/login")({
	beforeLoad: async ({ search }) => {
		const prefillEmail =
			typeof search.prefillEmail === "string" ? search.prefillEmail : undefined;
		if (prefillEmail) {
			return;
		}

		const accountsList = await storage.getAccountsList();
		if (accountsList.length === 0) {
			return;
		}

		let activeAccount = await storage.getActiveAccount();
		if (!activeAccount) {
			const firstAccount = accountsList[0];
			if (!firstAccount) {
				return;
			}
			activeAccount = {
				type: "single",
				accountId: firstAccount.accountId,
			};
			await storage.setActiveAccount(activeAccount);
		}

		if (activeAccount.type === "all") {
			const unlockedAccounts = await storage.getUnlockedAccounts?.();
			throw redirect({
				to: unlockedAccounts?.length ? "/vault" : "/unlock",
			});
		}

		const activeAccountMetadata = accountsList.find(
			(account) => account.accountId === activeAccount.accountId,
		);
		const sessionValid = await storage.isSessionValid(activeAccount.accountId);
		if (sessionValid) {
			const restored = await getAccountSessionManager({
				storage,
			}).unlockAccount(activeAccount.accountId, true);
			if (restored) {
				throw redirect({ to: "/vault" });
			}
		}

		throw redirect({
			to: "/unlock",
			search: activeAccountMetadata?.email
				? { email: activeAccountMetadata.email }
				: undefined,
		});
	},
	component: LoginPage,
	validateSearch: (search: Record<string, unknown>): LoginSearchParams => ({
		prefillEmail:
			typeof search.prefillEmail === "string" ? search.prefillEmail : undefined,
	}),
});

export function LoginPage() {
	const { m } = useI18n();
	const { prefillEmail } = Route.useSearch();
	const queryClient = useQueryClient();
	const fallbackServerUrl =
		normalizeServerUrl(import.meta.env.VITE_SERVER_URL ?? "") ??
		"http://localhost:3000";

	const [serverUrl, setServerUrl] = useState(fallbackServerUrl);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [secretKey, setSecretKey] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [showSecretKey, setShowSecretKey] = useState(false);
	const [enableBiometric, setEnableBiometric] = useState(true);
	const [isPrefilled, setIsPrefilled] = useState(false);

	const { data: biometricAvailable } = useQuery({
		queryKey: ["biometry-available"],
		queryFn: async () => {
			return await storage.isBiometricAvailable();
		},
	});

	const applyServerUrl = async (candidateUrl: string) => {
		const nextServerUrl = await setActiveAuthServerUrl(candidateUrl);
		if (!nextServerUrl) {
			toast.error(m.toast_auth_server_invalid_url());
			return null;
		}

		setServerUrl(nextServerUrl);
		return nextServerUrl;
	};

	// Prefill from account data when redirected from unauthorized error
	useEffect(() => {
		let active = true;

		const prefill = async () => {
			if (prefillEmail) {
				const [storedSecretKey, storedServerUrl] = await Promise.all([
					storage.getStoredSecretKey(prefillEmail),
					storage.getServerUrl(prefillEmail),
				]);
				if (!active) return;

				setEmail(prefillEmail);
				if (storedSecretKey) setSecretKey(storedSecretKey);
				if (storedServerUrl) {
					const appliedServerUrl =
						await setActiveAuthServerUrl(storedServerUrl);
					if (!active) return;
					if (appliedServerUrl) {
						setServerUrl(appliedServerUrl);
					}
				} else {
					const resolvedServerUrl = await resolveActiveAuthServerUrl();
					if (active) {
						setServerUrl(resolvedServerUrl);
					}
				}
				if (!active) return;
				setIsPrefilled(true);
			} else {
				const resolvedServerUrl = await resolveActiveAuthServerUrl();
				if (active) {
					setServerUrl(resolvedServerUrl);
				}
			}
		};

		void prefill();
		return () => {
			active = false;
		};
	}, [prefillEmail]);

	useEffect(() => {
		const unsubscribe = subscribeActiveAuthServerUrl((nextServerUrl) => {
			setServerUrl(nextServerUrl);
		});

		return () => {
			unsubscribe();
		};
	}, []);

	const loginMutation = useLogin({
		enableBiometric: enableBiometric && !!biometricAvailable,
		onSuccess: async (_result) => {
			const normalizedServerUrl = normalizeServerUrl(serverUrl);

			if (normalizedServerUrl) {
				const activeAccount = await storage.getActiveAccount();
				if (activeAccount?.type === "single") {
					await storage.storeServerUrl(
						normalizedServerUrl,
						activeAccount.accountId,
					);
				}
			}

			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["accounts"] }),
				queryClient.invalidateQueries({ queryKey: ["items"] }),
				queryClient.invalidateQueries({ queryKey: ["vault-items"] }),
				queryClient.invalidateQueries({ queryKey: ["decrypted-item"] }),
			]);

			toast.success(m.toast_auth_signin_success_simple());
			triggerAuthRevealToVault();
		},
		onError: (error) => {
			console.error("Login error:", error);
			toast.error(
				error instanceof Error ? error.message : m.toast_auth_signin_error(),
			);
		},
	});

	const handleLogin = async (e: React.FormEvent) => {
		e.preventDefault();

		const nextServerUrl = await applyServerUrl(serverUrl);
		if (!nextServerUrl) {
			return;
		}

		await loginMutation.mutateAsync({
			email,
			password,
			secretKey,
			serverUrl: nextServerUrl,
			enableBiometric: enableBiometric && !!biometricAvailable,
		});
	};

	return (
		<AuthDoorsLayout>
			<div className="w-full max-w-sm space-y-6">
				{isPrefilled && (
					<div className="rounded-lg border border-amber-200/60 bg-amber-50/50 px-4 py-3 dark:border-amber-500/20 dark:bg-amber-950/20">
						<p className="font-medium text-amber-900 text-sm dark:text-amber-200">
							{m.auth_signin_session_expired_title()}
						</p>
						<p className="mt-0.5 text-amber-800/70 text-xs dark:text-amber-300/70">
							{m.auth_signin_session_expired_desktop_description()}
						</p>
					</div>
				)}

				<div>
					<h2 className="font-semibold text-xl tracking-tight">
						{m.auth_signin_title_default()}
					</h2>
					<p className="mt-1 text-muted-foreground text-sm">
						{m.auth_signin_description_default()}
					</p>
				</div>

				<form onSubmit={handleLogin} className="space-y-4">
					<div className="grid gap-1.5">
						<Label htmlFor="email">{m.auth_signin_label_email()}</Label>
						<Input
							id="email"
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							required
							placeholder={m.auth_signin_placeholder_email()}
							disabled={isPrefilled}
						/>
					</div>

					<div className="grid gap-1.5">
						<Label htmlFor="secretKey">
							{m.auth_signin_label_secret_key()}
						</Label>
						<InputGroup>
							<InputGroupInput
								id="secretKey"
								type={showSecretKey ? "text" : "password"}
								value={secretKey}
								onChange={(e) => setSecretKey(e.target.value)}
								required
								placeholder={m.auth_signin_placeholder_secret_key()}
								className="font-mono"
							/>
							<InputGroupAddon align="inline-end">
								<InputGroupButton
									type="button"
									size="icon-xs"
									onClick={() => setShowSecretKey(!showSecretKey)}
								>
									{showSecretKey ? (
										<IconEyeSlashOutlineDuo18 className="h-3.5 w-3.5" />
									) : (
										<IconEyeOutlineDuo18 className="h-3.5 w-3.5" />
									)}
								</InputGroupButton>
							</InputGroupAddon>
						</InputGroup>
						<p className="text-muted-foreground text-xs">
							{m.auth_signin_secret_key_help()}
						</p>
					</div>

					<div className="grid gap-1.5">
						<Label htmlFor="password">{m.auth_signin_label_password()}</Label>
						<InputGroup>
							<InputGroupInput
								id="password"
								type={showPassword ? "text" : "password"}
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								required
								placeholder={m.auth_signin_placeholder_password()}
							/>
							<InputGroupAddon align="inline-end">
								<InputGroupButton
									type="button"
									size="icon-xs"
									onClick={() => setShowPassword(!showPassword)}
								>
									{showPassword ? (
										<IconEyeSlashOutlineDuo18 className="h-3.5 w-3.5" />
									) : (
										<IconEyeOutlineDuo18 className="h-3.5 w-3.5" />
									)}
								</InputGroupButton>
							</InputGroupAddon>
						</InputGroup>
					</div>

					{biometricAvailable && (
						<div className="flex items-center gap-2">
							<Checkbox
								id="biometric"
								checked={enableBiometric}
								onCheckedChange={(checked) =>
									setEnableBiometric(checked === true)
								}
							/>
							<Label
								htmlFor="biometric"
								className="flex items-center gap-2 font-normal"
							>
								<IconFingerprintOutlineDuo18 className="h-4 w-4 text-muted-foreground" />
								{m.auth_signin_biometric_enable()}
							</Label>
						</div>
					)}

					<Button
						type="submit"
						className="w-full"
						disabled={loginMutation.isPending}
					>
						{loginMutation.isPending
							? m.auth_signin_button_signing_in()
							: m.auth_signin_button_sign_in()}
					</Button>
				</form>
			</div>
		</AuthDoorsLayout>
	);
}
