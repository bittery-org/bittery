import { useLogin } from "@bittery/core/hooks";
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
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AuthDoorsLayout } from "@/components/auth/auth-doors-layout";
import { triggerAuthRevealToVault } from "@/lib/auth-reveal-transition";
import {
	resolveActiveAuthServerUrl,
	setActiveAuthServerUrl,
	subscribeActiveAuthServerUrl,
} from "@/lib/auth-server";
import { type AccountMetadata, storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

interface LoginSearchParams {
	prefillEmail?: string;
}

export const Route = createFileRoute("/login")({
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
			toast.error(m["toast.auth.server.invalid_url"]());
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
		onSuccess: async (result, input) => {
			const normalizedEmail = input.email.toLowerCase();
			const normalizedServerUrl = normalizeServerUrl(serverUrl);

			if (normalizedServerUrl) {
				await storage.storeServerUrl(normalizedServerUrl, normalizedEmail);
			}

			const secretKeyHint = `${input.secretKey.substring(0, 5)}...`;
			const accountMetadata: AccountMetadata = {
				email: normalizedEmail,
				userId: result.user.id,
				name: result.user.name || normalizedEmail.split("@")[0],
				teamName: result.user.teamName,
				secretKeyHint,
				addedAt: Date.now(),
				lastActiveAt: Date.now(),
				biometricEnabled: enableBiometric && !!biometricAvailable,
			};

			await storage.addAccountToList(accountMetadata);

			// Clear stale item cache for this account (e.g. from a previous session)
			if (storage.clearItemCache) {
				await storage.clearItemCache(normalizedEmail);
			}

			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["accounts"] }),
				queryClient.invalidateQueries({ queryKey: ["items"] }),
				queryClient.invalidateQueries({ queryKey: ["vault-items"] }),
				queryClient.invalidateQueries({ queryKey: ["decrypted-item"] }),
			]);

			toast.success(m["toast.auth.signin_success_simple"]());
			triggerAuthRevealToVault();
		},
		onError: (error) => {
			console.error("Login error:", error);
			toast.error(
				error instanceof Error ? error.message : m["toast.auth.signin_error"](),
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
			enableBiometric: enableBiometric && !!biometricAvailable,
		});
	};

	return (
		<AuthDoorsLayout>
			<div className="w-full max-w-sm space-y-6">
				{isPrefilled && (
					<div className="rounded-lg border border-amber-200/60 bg-amber-50/50 px-4 py-3 dark:border-amber-500/20 dark:bg-amber-950/20">
						<p className="font-medium text-amber-900 text-sm dark:text-amber-200">
							{m["auth.signin.session_expired.title"]()}
						</p>
						<p className="mt-0.5 text-amber-800/70 text-xs dark:text-amber-300/70">
							{m["auth.signin.session_expired.desktop_description"]()}
						</p>
					</div>
				)}

				<div>
					<h2 className="font-semibold text-xl tracking-tight">
						{m["auth.signin.title.default"]()}
					</h2>
					<p className="mt-1 text-muted-foreground text-sm">
						{m["auth.signin.description.default"]()}
					</p>
				</div>

				<form onSubmit={handleLogin} className="space-y-4">
					<div className="grid gap-1.5">
						<Label htmlFor="email">{m["auth.signin.label.email"]()}</Label>
						<Input
							id="email"
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							required
							placeholder={m["auth.signin.placeholder.email"]()}
							disabled={isPrefilled}
						/>
					</div>

					<div className="grid gap-1.5">
						<Label htmlFor="secretKey">
							{m["auth.signin.label.secret_key"]()}
						</Label>
						<InputGroup>
							<InputGroupInput
								id="secretKey"
								type={showSecretKey ? "text" : "password"}
								value={secretKey}
								onChange={(e) => setSecretKey(e.target.value)}
								required
								placeholder={m["auth.signin.placeholder.secret_key"]()}
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
							{m["auth.signin.secret_key.help"]()}
						</p>
					</div>

					<div className="grid gap-1.5">
						<Label htmlFor="password">{m["auth.signin.label.password"]()}</Label>
						<InputGroup>
							<InputGroupInput
								id="password"
								type={showPassword ? "text" : "password"}
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								required
								placeholder={m["auth.signin.placeholder.password"]()}
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
								{m["auth.signin.biometric.enable"]()}
							</Label>
						</div>
					)}

					<Button
						type="submit"
						className="w-full"
						disabled={loginMutation.isPending}
					>
						{loginMutation.isPending
							? m["auth.signin.button.signing_in"]()
							: m["auth.signin.button.sign_in"]()}
					</Button>
				</form>
			</div>
		</AuthDoorsLayout>
	);
}
