import { useLogin } from "@bittery/hooks";
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
import { useEffect, useState } from "react";
import { type AccountMetadata, storage } from "@/lib/storage";

interface AddAccountDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function AddAccountDialog({
	open,
	onOpenChange,
}: AddAccountDialogProps) {
	const navigate = useNavigate();
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

	const { data: biometricAvailable } = useQuery({
		queryKey: ["biometry-available"],
		queryFn: async () => {
			return await storage.isBiometricAvailable();
		},
	});

	// Reset form when dialog opens
	useEffect(() => {
		if (open) {
			setEmail("");
			setPassword("");
			setSecretKey("");
			setShowPassword(false);
			setShowSecretKey(false);
			setEnableBiometric(true);

			// Load server URL
			storage.getLegacyServerUrl().then((stored) => {
				if (stored) setServerUrl(stored);
			});
		}
	}, [open]);

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
			await queryClient.invalidateQueries({ queryKey: ["accounts"] });

			toast.success("Account added successfully");
			onOpenChange(false);
			navigate({ to: "/vault" });
		},
		onError: (error) => {
			console.error("Login error:", error);
			toast.error(error instanceof Error ? error.message : "Login failed");
		},
	});

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();

		const normalizedServerUrl = normalizeServerUrl(serverUrl);
		if (!normalizedServerUrl) {
			toast.error("Invalid server URL");
			return;
		}
		if (normalizedServerUrl !== serverUrl) {
			setServerUrl(normalizedServerUrl);
		}

		await loginMutation.mutateAsync({
			email,
			password,
			secretKey,
			enableBiometric: enableBiometric && !!biometricAvailable,
		});
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Add Account</DialogTitle>
					<DialogDescription>
						Sign in with another account to add it to your device
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={handleSubmit} className="space-y-4">
					<div className="grid gap-1.5">
						<Label htmlFor="add-serverUrl">Server URL</Label>
						<Input
							id="add-serverUrl"
							type="url"
							value={serverUrl}
							onChange={(e) => setServerUrl(e.target.value)}
							onBlur={() => {
								const normalized = normalizeServerUrl(serverUrl);
								if (!normalized) {
									toast.error("Invalid server URL");
									return;
								}
								if (normalized !== serverUrl) {
									setServerUrl(normalized);
								}
							}}
							required
							placeholder="https://your-server.com"
						/>
					</div>

					<div className="grid gap-1.5">
						<Label htmlFor="add-email">Email</Label>
						<Input
							id="add-email"
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							required
							placeholder="you@example.com"
						/>
					</div>

					<div className="grid gap-1.5">
						<Label htmlFor="add-secretKey">Secret Key</Label>
						<InputGroup>
							<InputGroupInput
								id="add-secretKey"
								type={showSecretKey ? "text" : "password"}
								value={secretKey}
								onChange={(e) => setSecretKey(e.target.value)}
								required
								placeholder="A3-XXXXXX-XXXXXX-XXXXX"
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
						<Label htmlFor="add-password">Password</Label>
						<InputGroup>
							<InputGroupInput
								id="add-password"
								type={showPassword ? "text" : "password"}
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								required
								placeholder="Enter your password"
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
								Enable biometric unlock
							</Label>
						</div>
					)}

					<Button
						type="submit"
						className="w-full"
						disabled={loginMutation.isPending}
					>
						{loginMutation.isPending ? "Adding account..." : "Add Account"}
					</Button>
				</form>
			</DialogContent>
		</Dialog>
	);
}
