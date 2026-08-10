import { getDefaultServerUrl } from "@bittery/shared/api-client-factory";
import { normalizeServerUrl } from "@bittery/shared/server-url";
import { Button, toast } from "@bittery/ui";
import {
	IconArrowLeft,
	IconChevronRight,
	IconEye,
	IconEyeOff,
	IconPasskey,
	IconShieldCheck,
	IconZap,
} from "@bittery/ui/icons";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import logoWordmark from "../assets/logo.png";
import { storage } from "../lib/storage";
import { useI18n } from "../providers/i18n-provider";

const labelClass =
	"mb-[5px] block font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]";
const fieldClass =
	"flex h-[34px] items-center gap-2 rounded-lg border bg-transparent px-2.5 transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25 dark:bg-input/20";
const fieldInputClass =
	"min-w-0 flex-1 bg-transparent text-foreground text-sm outline-none placeholder:text-muted-foreground";

export function LoginPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { m } = useI18n();
	const { addingAccount } = useSearch({ from: "/login" });
	const [showPassword, setShowPassword] = useState(false);
	const [showSecretKey, setShowSecretKey] = useState(false);

	const defaultServerUrl = getDefaultServerUrl();

	// Load any previously-stored server URL. Kept in a query so we don't need an
	// effect to hydrate the controlled input.
	const { data: storedServerUrl } = useQuery({
		queryKey: ["login-server-url"],
		queryFn: async () => (await storage.getServerUrl()) ?? null,
	});

	const [serverUrlOverride, setServerUrlOverride] = useState<string | null>(
		null,
	);
	const serverUrl = serverUrlOverride ?? storedServerUrl ?? defaultServerUrl;

	// The self-hosted disclosure auto-expands whenever an active non-default
	// server URL is present, so we never hide a value the user relies on.
	const hasCustomServer =
		normalizeServerUrl(serverUrl) !== normalizeServerUrl(defaultServerUrl);
	const [advOpenOverride, setAdvOpenOverride] = useState<boolean | null>(null);
	const advOpen = advOpenOverride ?? hasCustomServer;

	const persistServerUrl = async () => {
		const normalized = normalizeServerUrl(serverUrl);
		if (!normalized) {
			toast.error(m.ext_login_toast_invalid_server_url());
			return null;
		}
		if (normalized !== serverUrl) {
			setServerUrlOverride(normalized);
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
			await loginMutation.mutateAsync({ ...value, serverUrl: persisted });
		},
	});

	const loginMutation = useMutation({
		mutationFn: async (values: {
			email: string;
			password: string;
			secretKey: string;
			serverUrl: string;
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

	const features = [
		{ icon: IconZap, label: m.ext_login_feature_autofill() },
		{ icon: IconPasskey, label: m.ext_login_feature_passkeys() },
		{ icon: IconShieldCheck, label: m.ext_login_feature_encrypted() },
	];

	return (
		<div className="flex h-[520px] min-h-[520px]">
			{/* Brand aside */}
			<aside className="relative flex w-[230px] shrink-0 flex-col justify-between overflow-hidden border-r bg-sidebar px-5 py-[22px]">
				<div
					aria-hidden
					className="pointer-events-none absolute inset-x-0 top-0 h-56 bg-[radial-gradient(120%_100%_at_30%_0%,color-mix(in_oklab,var(--color-primary-deep)_8%,transparent),transparent_65%)] dark:bg-[radial-gradient(120%_100%_at_30%_0%,color-mix(in_oklab,var(--color-primary-deep)_14%,transparent),transparent_65%)]"
				/>
				<div className="relative">
					<img
						src={logoWordmark}
						alt="Bittery"
						className="h-[30px] w-auto [filter:drop-shadow(0_0_18px_color-mix(in_oklab,var(--color-primary-deep)_22%,transparent))] dark:[filter:drop-shadow(0_0_18px_color-mix(in_oklab,var(--color-primary-deep)_35%,transparent))]"
					/>
					<p className="mt-3 text-muted-foreground text-xs leading-relaxed">
						{m.ext_login_brand_tagline()}
					</p>
				</div>
				<div className="relative flex flex-col gap-[9px]">
					{features.map(({ icon: Icon, label }) => (
						<span
							key={label}
							className="flex items-center gap-2 text-[11.5px] text-foreground/80"
						>
							<Icon className="size-3.5 shrink-0 text-primary [filter:drop-shadow(0_0_4px_color-mix(in_oklab,var(--color-primary)_50%,transparent))]" />
							{label}
						</span>
					))}
				</div>
			</aside>

			{/* Form pane */}
			<div className="flex-1 overflow-y-auto px-[26px] py-6">
				{addingAccount && (
					<button
						type="button"
						onClick={handleBackToVault}
						className="mb-3 -ml-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
					>
						<IconArrowLeft className="size-3.5" />
						{m.ext_login_back()}
					</button>
				)}
				<h1 className="font-semibold text-[15px] tracking-tight">
					{addingAccount
						? m.ext_login_title_add_account()
						: m.ext_login_heading_sign_in()}
				</h1>
				<p className="mt-0.5 mb-4 text-muted-foreground text-xs">
					{addingAccount ? m.ext_login_lead_add_account() : m.ext_login_lead()}
				</p>

				<form
					onSubmit={(e) => {
						e.preventDefault();
						form.handleSubmit();
					}}
				>
					<form.Field name="email">
						{(field) => (
							<div className="mb-3">
								<label htmlFor={field.name} className={labelClass}>
									{m.auth_signin_label_email()}
								</label>
								<div className={fieldClass}>
									<input
										id={field.name}
										name={field.name}
										type="email"
										placeholder={m.auth_signin_placeholder_email()}
										value={field.state.value}
										onChange={(e) => field.handleChange(e.target.value)}
										required
										className={fieldInputClass}
									/>
								</div>
							</div>
						)}
					</form.Field>

					<form.Field name="password">
						{(field) => (
							<div className="mb-3">
								<label htmlFor={field.name} className={labelClass}>
									{m.ext_login_label_master_password()}
								</label>
								<div className={fieldClass}>
									<input
										id={field.name}
										name={field.name}
										type={showPassword ? "text" : "password"}
										placeholder="••••••••••••"
										value={field.state.value}
										onChange={(e) => field.handleChange(e.target.value)}
										required
										className={fieldInputClass}
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
							</div>
						)}
					</form.Field>

					<form.Field name="secretKey">
						{(field) => (
							<div className="mb-3">
								<label htmlFor={field.name} className={labelClass}>
									{m.auth_signin_label_secret_key()}
								</label>
								<div className={fieldClass}>
									<input
										id={field.name}
										name={field.name}
										type={showSecretKey ? "text" : "password"}
										placeholder={m.auth_signin_placeholder_secret_key()}
										value={field.state.value}
										onChange={(e) => field.handleChange(e.target.value)}
										required
										className={`${fieldInputClass} font-mono text-xs tracking-[0.05em]`}
									/>
									<button
										type="button"
										onClick={() => setShowSecretKey(!showSecretKey)}
										className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
									>
										{showSecretKey ? (
											<IconEyeOff className="size-3.5" />
										) : (
											<IconEye className="size-3.5" />
										)}
									</button>
								</div>
							</div>
						)}
					</form.Field>

					<button
						type="button"
						onClick={() => setAdvOpenOverride(!advOpen)}
						className="mb-3 inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
						aria-expanded={advOpen}
					>
						<IconChevronRight
							className={`size-3 transition-transform ${
								advOpen ? "rotate-90" : ""
							}`}
						/>
						{m.ext_login_self_hosted_server()}
					</button>

					{advOpen && (
						<div className="mb-3">
							<label htmlFor="serverUrl" className={labelClass}>
								{m.ext_login_label_server_url()}
							</label>
							<div className={fieldClass}>
								<input
									id="serverUrl"
									name="serverUrl"
									type="url"
									placeholder="https://bittery.example.com"
									value={serverUrl}
									onChange={(e) => setServerUrlOverride(e.target.value)}
									className={fieldInputClass}
								/>
							</div>
							<p className="mt-1.5 text-[11px] text-muted-foreground">
								{m.ext_login_server_url_hint()}
							</p>
						</div>
					)}

					<Button
						type="submit"
						className="mt-1 h-[34px] w-full rounded-lg"
						disabled={loginMutation.isPending}
					>
						{loginMutation.isPending
							? m.auth_signin_button_signing_in()
							: m.auth_signin_button_sign_in()}
					</Button>
				</form>
			</div>
		</div>
	);
}
