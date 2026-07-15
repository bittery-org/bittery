import { useLogin } from "@bittery/core/hooks";
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
import {
	IconEyeOutlineDuo18,
	IconEyeSlashOutlineDuo18,
	IconFingerprintOutlineDuo18,
} from "@bittery/ui/icons";
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
	const legacyServerUrlQuery = useQuery({
		queryKey: ["desktop", "legacy-server-url"],
		queryFn: () => storage.getLegacyServerUrl(),
		enabled: open,
	});
	const fallbackServerUrl =
		normalizeServerUrl(import.meta.env.VITE_SERVER_URL ?? "") ??
		"http://localhost:3000";
	const initialServerUrl =
		normalizeServerUrl(legacyServerUrlQuery.data ?? "") ?? fallbackServerUrl;

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

		const normalizedServerUrl = normalizeServerUrl(serverUrl);
		if (!normalizedServerUrl) {
			toast.error(m.toast_auth_server_invalid_url());
			return;
		}
		if (normalizedServerUrl !== serverUrl) {
			setServerUrl(normalizedServerUrl);
		}

		await loginMutation.mutateAsync({
			email,
			password,
			secretKey,
			serverUrl: normalizedServerUrl,
			enableBiometric: enableBiometric && !!biometricAvailable,
		});
	};

	return (
		<DialogContent className="sm:max-w-md">
			<DialogHeader>
				<DialogTitle>
					{m.vaults_sidebar_account_switcher_menu_add_account()}
				</DialogTitle>
				<DialogDescription>
					{m.auth_signin_button_different_account()}
				</DialogDescription>
			</DialogHeader>

			<form onSubmit={handleSubmit} className="space-y-4">
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
									<IconEyeSlashOutlineDuo18 className="h-3.5 w-3.5" />
								) : (
									<IconEyeOutlineDuo18 className="h-3.5 w-3.5" />
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
							id="add-biometric"
							checked={enableBiometric}
							onCheckedChange={(checked) =>
								setEnableBiometric(checked === true)
							}
						/>
						<Label
							htmlFor="add-biometric"
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
						: m.vaults_sidebar_account_switcher_menu_add_account()}
				</Button>
			</form>
		</DialogContent>
	);
}
