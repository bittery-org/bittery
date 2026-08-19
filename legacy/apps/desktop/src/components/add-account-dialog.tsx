import { useLogin } from "@bittery/core/hooks";
import { isRemoteHttpServer } from "@bittery/shared/server-transport-policy";
import { normalizeServerUrl } from "@bittery/shared/server-url";
import {
	Button,
	Checkbox,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	Input,
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
	Label,
	toast,
} from "@bittery/ui";
import { IconEye, IconEyeOff, IconFingerprint } from "@bittery/ui/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

interface AddAccountDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function AddAccountDialog({
	open,
	onOpenChange,
}: AddAccountDialogProps) {
	// Prefill the new account's form with the active account's server, which is what a
	// second account on the same server needs.
	const activeServerUrlQuery = useQuery({
		queryKey: ["desktop", "active-account-server-url"],
		queryFn: () => storage.getServerUrl(),
		enabled: open,
	});
	const fallbackServerUrl =
		normalizeServerUrl(import.meta.env.VITE_SERVER_URL ?? "") ??
		"http://localhost:3000";
	const initialServerUrl =
		normalizeServerUrl(activeServerUrlQuery.data ?? "") ?? fallbackServerUrl;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{open ? (
				<AddAccountDialogForm
					key={`${open ? "open" : "closed"}:${initialServerUrl}`}
					onOpenChange={onOpenChange}
					initialServerUrl={initialServerUrl}
				/>
			) : null}
		</Dialog>
	);
}

function AddAccountDialogForm({
	onOpenChange,
	initialServerUrl,
}: Omit<AddAccountDialogProps, "open"> & {
	initialServerUrl: string;
}) {
	const { m } = useI18n();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [serverUrl, setServerUrl] = useState(initialServerUrl);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [secretKey, setSecretKey] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [showSecretKey, setShowSecretKey] = useState(false);
	const [enableBiometric, setEnableBiometric] = useState(true);
	const [insecureTransportConfirmed, setInsecureTransportConfirmed] =
		useState(false);
	const normalizedCandidate = normalizeServerUrl(serverUrl, {
		operatorEnabled: true,
		accountConfirmed: true,
	});
	const requiresInsecureTransportConfirmation = normalizedCandidate
		? isRemoteHttpServer(normalizedCandidate)
		: false;

	const { data: biometricAvailable } = useQuery({
		queryKey: ["biometry-available"],
		queryFn: async () => {
			return await storage.isBiometricAvailable();
		},
	});

	const loginMutation = useLogin({
		enableBiometric: enableBiometric && !!biometricAvailable,
		onSuccess: async (_result) => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["accounts"] }),
				queryClient.invalidateQueries({ queryKey: ["items"] }),
				queryClient.invalidateQueries({ queryKey: ["vault-items"] }),
				queryClient.invalidateQueries({ queryKey: ["decrypted-item"] }),
			]);

			toast.success(m.toast_auth_signin_success_simple());
			onOpenChange(false);
			navigate({ to: "/vault" });
		},
		onError: (error) => {
			console.error("Login error:", error);
			toast.error(m.toast_auth_signin_error());
		},
	});

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();

		const normalizedServerUrl = normalizedCandidate;
		if (!normalizedServerUrl) {
			toast.error(m.toast_auth_server_invalid_url());
			return;
		}
		if (normalizedServerUrl !== serverUrl) {
			setServerUrl(normalizedServerUrl);
		}
		if (requiresInsecureTransportConfirmation && !insecureTransportConfirmed) {
			toast.error(m.auth_insecure_http_confirmation_required());
			return;
		}

		await loginMutation.mutateAsync({
			email,
			password,
			secretKey,
			serverUrl: normalizedServerUrl,
			insecureTransportConfirmed,
			enableBiometric: enableBiometric && !!biometricAvailable,
		});
	};

	return (
		<DialogContent className="gap-0 p-0 sm:max-w-md">
			<DialogHeader className="relative gap-1 px-5 pt-5 pb-4 text-left">
				<DialogTitle>
					{m.vaults_sidebar_account_switcher_menu_add_account()}
				</DialogTitle>
				<DialogDescription>
					{m.auth_signin_button_different_account()}
				</DialogDescription>
			</DialogHeader>

			<form onSubmit={handleSubmit} className="flex flex-col gap-4 px-5 pb-5">
				<div className="grid gap-1.5">
					<Label htmlFor="add-serverUrl">{m.auth_footer_server_title()}</Label>
					<Input
						id="add-serverUrl"
						type="url"
						value={serverUrl}
						onChange={(e) => setServerUrl(e.target.value)}
						onBlur={() => {
							const normalized = normalizeServerUrl(serverUrl);
							if (!normalized) {
								toast.error(m.toast_auth_server_invalid_url());
								return;
							}
							if (normalized !== serverUrl) {
								setServerUrl(normalized);
							}
						}}
						required
						placeholder={m.auth_footer_server_placeholder()}
						className="font-mono"
					/>
				</div>

				<div className="grid gap-1.5">
					<Label htmlFor="add-email">{m.auth_signin_label_email()}</Label>
					<Input
						id="add-email"
						type="email"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						required
						placeholder={m.auth_signin_placeholder_email()}
					/>
				</div>

				<div className="grid gap-1.5">
					<Label htmlFor="add-secretKey">
						{m.auth_signin_label_secret_key()}
					</Label>
					<InputGroup>
						<InputGroupInput
							id="add-secretKey"
							type={showSecretKey ? "text" : "password"}
							value={secretKey}
							onChange={(e) => setSecretKey(e.target.value)}
							required
							placeholder={m.auth_signin_placeholder_secret_key()}
							className="font-mono"
						/>
						<InputGroupAddon align="inline-end">
							<InputGroupButton
								size="icon-xs"
								onClick={() => setShowSecretKey(!showSecretKey)}
							>
								{showSecretKey ? (
									<IconEyeOff className="h-3.5 w-3.5" />
								) : (
									<IconEye className="h-3.5 w-3.5" />
								)}
							</InputGroupButton>
						</InputGroupAddon>
					</InputGroup>
				</div>

				<div className="grid gap-1.5">
					<Label htmlFor="add-password">{m.auth_signin_label_password()}</Label>
					<InputGroup>
						<InputGroupInput
							id="add-password"
							type={showPassword ? "text" : "password"}
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							required
							placeholder={m.auth_signin_placeholder_password()}
						/>
						<InputGroupAddon align="inline-end">
							<InputGroupButton
								size="icon-xs"
								onClick={() => setShowPassword(!showPassword)}
							>
								{showPassword ? (
									<IconEyeOff className="h-3.5 w-3.5" />
								) : (
									<IconEye className="h-3.5 w-3.5" />
								)}
							</InputGroupButton>
						</InputGroupAddon>
					</InputGroup>
				</div>

				{biometricAvailable && (
					<Label
						htmlFor="add-biometric"
						className="flex cursor-pointer items-center gap-2.5 rounded-md border bg-foreground/3 px-3 py-2.5 font-normal transition-colors hover:bg-foreground/5"
					>
						<IconFingerprint className="size-4 shrink-0 text-muted-foreground" />
						<span className="flex-1">{m.auth_signin_biometric_enable()}</span>
						<Checkbox
							id="add-biometric"
							checked={enableBiometric}
							onCheckedChange={(checked) =>
								setEnableBiometric(checked === true)
							}
						/>
					</Label>
				)}

				{requiresInsecureTransportConfirmation ? (
					<Label
						htmlFor="add-insecure-http-confirmation"
						className="flex cursor-pointer items-start gap-2.5 rounded-md border bg-foreground/3 px-3 py-2.5 font-normal transition-colors hover:bg-foreground/5"
					>
						<Checkbox
							id="add-insecure-http-confirmation"
							checked={insecureTransportConfirmed}
							onCheckedChange={(checked) =>
								setInsecureTransportConfirmed(checked === true)
							}
						/>
						<span className="grid gap-0.5">
							<span>{m.auth_insecure_http_confirmation_label()}</span>
							<span className="text-muted-foreground text-xs">
								{m.auth_insecure_http_confirmation_description()}
							</span>
						</span>
					</Label>
				) : null}

				<Button
					type="submit"
					className="mt-1 w-full"
					disabled={loginMutation.isPending}
				>
					{loginMutation.isPending
						? m.auth_signin_button_signing_in()
						: m.vaults_sidebar_account_switcher_menu_add_account()}
				</Button>
			</form>
		</DialogContent>
	);
}
