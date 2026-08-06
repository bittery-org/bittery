import { usePlatformCrypto } from "@bittery/core/hooks";
import { storeLoginSessionOwned } from "@bittery/core/services/auth-service";
import { createAccountKeys } from "@bittery/core/services/vault-crypto";
import { m } from "@bittery/i18n/paraglide/messages";
import { useRPC, useRPCClient } from "@bittery/shared/rpc";
import { getDefaultServerUrl } from "@bittery/shared/rpc-client-factory";
import { toAuthVaultKeyEntry } from "@bittery/shared/vault-mapping";
import { DEFAULT_SESSION_EXPIRY_MS } from "@bittery/storage";
import type { KdfProfile } from "@bittery/types";
import { toast } from "@bittery/ui";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { downloadRecoveryKit } from "@/lib/recovery-kit";
import { itemCache, refreshActiveAccountId, storage } from "@/lib/storage";

export type { CloudPlanId } from "@bittery/shared/pricing";

type CloudPlanId = import("@bittery/shared/pricing").CloudPlanId;

type SignupFormValues = {
	email: string;
	password: string;
	name: string;
	plan: CloudPlanId;
	organizationName: string;
};

type SignupMutationInput = {
	userId?: string;
	vaultId?: string;
	email: string;
	name: string;
	plan?: CloudPlanId;
	signupVerificationToken: string;
	secretKeyHint: string;
	srpSalt: string;
	srpVerifier: string;
	publicKey: string;
	encryptedPrivateKey: string;
	encryptedMasterKey: string;
	recoveryKeyHint: string;
	encryptedVaultKey: string;
	kdfProfile: KdfProfile;
	organizationName?: string;
	token?: string;
};

export function useSignupForm({
	invitationToken,
	redirectTo,
	initialPlan,
	verificationMode = "dialog",
	onVerificationRequested,
}: {
	invitationToken?: string;
	redirectTo?: string;
	initialPlan?: CloudPlanId;
	verificationMode?: "dialog" | "inline";
	onVerificationRequested?: () => void;
}) {
	const navigate = useNavigate();
	const rpc = useRPC();
	const rpcClient = useRPCClient();
	const crypto = usePlatformCrypto();
	const [keyMaterialQueryId] = useState(() => globalThis.crypto.randomUUID());
	const keyMaterialQuery = useQuery({
		queryKey: ["signup-key-material", keyMaterialQueryId],
		queryFn: async () => {
			const [secretKey, recoveryKey] = await Promise.all([
				crypto.generateSecretKey(),
				crypto.generateRecoveryKey(),
			]);
			return { secretKey, recoveryKey };
		},
		staleTime: Number.POSITIVE_INFINITY,
	});
	const secretKey = keyMaterialQuery.data?.secretKey ?? "";
	const recoveryKey = keyMaterialQuery.data?.recoveryKey ?? "";
	const [hasDownloadedKit, setHasDownloadedKit] = useState(false);
	const [showPassword, setShowPassword] = useState(false);
	const [isEncrypting, setIsEncrypting] = useState(false);
	const [verificationDialogOpen, setVerificationDialogOpen] = useState(false);
	const [verificationCode, setVerificationCode] = useState("");
	const [verificationEmail, setVerificationEmail] = useState("");
	const [pendingSubmission, setPendingSubmission] =
		useState<SignupFormValues | null>(null);
	const [signupVerificationToken, setSignupVerificationToken] = useState<
		string | null
	>(null);
	const [verifiedEmail, setVerifiedEmail] = useState<string | null>(null);
	const [verifiedInvitationToken, setVerifiedInvitationToken] = useState<
		string | null
	>(null);

	// Query invitation details if token is provided
	const invitationQuery = useQuery({
		...rpc.team.invitations.getByToken.queryOptions({
			token: invitationToken || "",
		}),
		enabled: !!invitationToken,
	});
	const registrationStatusQuery = useQuery(
		rpc.auth.registrationStatus.queryOptions(),
	);

	const invitation = invitationQuery.data;
	const hasInvitationToken = !!invitationToken;
	const isInvitationSignup = hasInvitationToken && !!invitation;
	const registrationStatus = registrationStatusQuery.data;
	const isSelfHostedMode = registrationStatus?.mode === "self-hosted";
	const isCloudMode = registrationStatus?.mode !== "self-hosted";
	const isCloudSelfServeSignup = isCloudMode && !isInvitationSignup;
	const isCloudBillingEnabled = registrationStatus?.billingEnabled ?? true;
	const allowPublicSignup = registrationStatus?.allowPublicSignup ?? true;
	const requiresEmailVerification =
		registrationStatus?.requiresEmailVerification ?? true;

	const getSignupEmail = (value: SignupFormValues) => {
		if (isInvitationSignup) {
			return invitation?.email.trim().toLowerCase() ?? "";
		}

		return value.email.trim().toLowerCase();
	};

	const resetVerifiedSignup = () => {
		setSignupVerificationToken(null);
		setVerifiedEmail(null);
		setVerifiedInvitationToken(null);
	};

	const requestSignupVerificationMutation = useMutation({
		mutationFn: async (input: { email: string }) =>
			rpcClient.auth.requestSignupVerification.mutate({
				email: input.email,
				invitationToken: invitationToken ?? null,
			}),
		onError: (error: any) => {
			toast.error(error.message || "Failed to send verification code");
		},
	});

	const verifySignupVerificationMutation = useMutation({
		mutationFn: async (input: { email: string; code: string }) =>
			rpcClient.auth.verifySignupVerification.mutate({
				email: input.email,
				code: input.code,
				invitationToken: invitationToken ?? null,
			}),
		onError: (error: any) => {
			toast.error(error.message || "Failed to verify code");
		},
	});

	const signupMutation = useMutation({
		mutationFn: async (input: SignupMutationInput) => {
			if (isInvitationSignup) {
				return rpcClient.auth.signupWithInvitation.mutate({
					token: input.token || "",
					userId: input.userId ?? null,
					vaultId: input.vaultId ?? null,
					email: input.email,
					signupVerificationToken: input.signupVerificationToken,
					name: input.name,
					secretKeyHint: input.secretKeyHint,
					srpSalt: input.srpSalt,
					srpVerifier: input.srpVerifier,
					publicKey: input.publicKey,
					encryptedPrivateKey: input.encryptedPrivateKey,
					encryptedMasterKey: input.encryptedMasterKey,
					recoveryKeyHint: input.recoveryKeyHint,
					encryptedVaultKey: input.encryptedVaultKey,
					kdfParams: input.kdfProfile,
				});
			}

			return rpcClient.auth.signup.mutate({
				userId: input.userId ?? null,
				vaultId: input.vaultId ?? null,
				email: input.email,
				signupVerificationToken: input.signupVerificationToken,
				name: input.name,
				plan: input.plan ?? null,
				organizationName: input.organizationName ?? null,
				secretKeyHint: input.secretKeyHint,
				srpSalt: input.srpSalt,
				srpVerifier: input.srpVerifier,
				publicKey: input.publicKey,
				encryptedPrivateKey: input.encryptedPrivateKey,
				encryptedMasterKey: input.encryptedMasterKey,
				recoveryKeyHint: input.recoveryKeyHint,
				encryptedVaultKey: input.encryptedVaultKey,
				kdfParams: input.kdfProfile,
			});
		},
		onError: (error: any) => {
			toast.error(error.message || "Failed to create account");
		},
	});

	/** Where a finished signup lands. Billing takes over when a paid plan was chosen. */
	const goAfterSignup = async (value: SignupFormValues) => {
		if (
			isCloudSelfServeSignup &&
			!isInvitationSignup &&
			isCloudBillingEnabled &&
			value.plan &&
			value.plan !== "free"
		) {
			try {
				const checkout = await rpcClient.billing.createCheckoutSession.mutate({
					plan: value.plan,
				});
				if (checkout.url) {
					window.location.href = checkout.url;
					return;
				}
			} catch (error: any) {
				toast.error(
					error?.message ||
						"Account created, but checkout could not be started. Open billing to continue.",
				);
				navigate({ to: "/billing" });
				return;
			}
		}

		// Invitation signup is accepted server-side.
		if (isInvitationSignup) {
			navigate({ to: "/team" });
		} else if (redirectTo) {
			navigate({ to: redirectTo });
		} else {
			navigate({ to: "/home" });
		}
	};

	const completeSignupSubmission = async (
		value: SignupFormValues,
		verificationToken: string,
	) => {
		const teamName = value.organizationName.trim();
		const email = getSignupEmail(value);
		if (!email) {
			toast.error("Unable to determine the signup email.");
			return;
		}

		setIsEncrypting(true);
		const serverUrl = getDefaultServerUrl();
		try {
			const { keys, result } = await createAccountKeys(
				{ email, password: value.password, secretKey, recoveryKey },
				{
					crypto,
					commit: (payload) =>
						signupMutation.mutateAsync({
							userId: payload.userId,
							vaultId: payload.vaultId,
							email,
							name: value.name,
							plan: isCloudBillingEnabled ? value.plan : "free",
							signupVerificationToken: verificationToken,
							...(isCloudSelfServeSignup && value.plan === "team" && teamName
								? { organizationName: teamName }
								: {}),
							...(isInvitationSignup ? { token: invitationToken } : {}),
							secretKeyHint: payload.secretKeyHint,
							srpSalt: payload.srpSalt,
							srpVerifier: payload.srpVerifier,
							publicKey: payload.publicKey,
							encryptedPrivateKey: payload.encryptedPrivateKey,
							encryptedMasterKey: payload.encryptedMasterKey,
							recoveryKeyHint: payload.recoveryKeyHint,
							encryptedVaultKey: payload.encryptedVaultKey,
							kdfProfile: payload.kdfProfile,
						}),
				},
			);

			// The same path a sign-in takes: it registers the account, points the active
			// account at it and clears any cache left under a reused id — none of which a
			// hand-rolled sequence of writes here ever did.
			await storeLoginSessionOwned(
				{
					token: result.token,
					sessionId: result.sessionId,
					expiresAt: result.expiresAt,
					user: {
						id: result.user.id,
						email: result.user.email,
						name: result.user.name,
						teamName: result.user.teamName ?? undefined,
						teamAvatarUrl: result.user.teamAvatarUrl,
						encryptedPrivateKey: keys.encryptedPrivateKey,
					},
					vaultKeys: result.vaultKeys.map(toAuthVaultKeyEntry),
					masterUnlockKey: keys.masterUnlockKey,
					kdfParams: keys.kdfProfile,
					serverUrl,
				},
				secretKey,
				storage,
				itemCache,
				crypto,
				email,
				{ serverUrl },
			);
			await refreshActiveAccountId();

			toast.success(m.auth_signup_toast_account_created());
			toast.success(
				m.auth_signup_toast_quick_unlock_days({
					daysUntil: String(
						Math.floor(DEFAULT_SESSION_EXPIRY_MS / (1000 * 60 * 60 * 24)),
					),
				}),
			);

			await goAfterSignup(value);
		} catch (error: any) {
			console.error("Signup error:", error);
			toast.error(error.message || "Failed to create account");
		} finally {
			setIsEncrypting(false);
		}
	};

	const beginSignupVerification = async (value: SignupFormValues) => {
		const email = getSignupEmail(value);
		if (!email) {
			toast.error("Unable to determine the signup email.");
			return;
		}

		resetVerifiedSignup();
		try {
			await requestSignupVerificationMutation.mutateAsync({ email });
		} catch {
			return;
		}
		setPendingSubmission(value);
		setVerificationEmail(email);
		setVerificationCode("");
		if (verificationMode === "dialog") {
			setVerificationDialogOpen(true);
		}
		onVerificationRequested?.();
		toast.success("Verification code sent. Check your inbox.");
	};

	const submitSignupVerificationCode = async () => {
		const currentValues = form.state.values;
		const currentEmail = getSignupEmail(currentValues);
		const hasMatchingVerification =
			signupVerificationToken &&
			verifiedEmail === currentEmail &&
			verifiedInvitationToken === (invitationToken ?? null);

		if (hasMatchingVerification && signupVerificationToken) {
			await completeSignupSubmission(currentValues, signupVerificationToken);
			return;
		}

		if (!pendingSubmission) {
			return;
		}

		const code = verificationCode.trim();
		if (code.length !== 6) {
			toast.error("Enter the 6-digit verification code.");
			return;
		}

		try {
			const result = await verifySignupVerificationMutation.mutateAsync({
				email: verificationEmail,
				code,
			});

			if (!result.success || !result.signupVerificationToken) {
				toast.error("Invalid or expired verification code.");
				return;
			}

			setSignupVerificationToken(result.signupVerificationToken);
			setVerifiedEmail(verificationEmail.trim().toLowerCase());
			setVerifiedInvitationToken(invitationToken ?? null);
			if (verificationMode === "dialog") {
				setVerificationDialogOpen(false);
			}
			setVerificationCode("");
			const submission = pendingSubmission;
			setPendingSubmission(null);
			await completeSignupSubmission(
				submission,
				result.signupVerificationToken,
			);
		} catch {
			return;
		}
	};

	const resendSignupVerificationCode = async () => {
		if (!verificationEmail) {
			return;
		}

		try {
			await requestSignupVerificationMutation.mutateAsync({
				email: verificationEmail,
			});
		} catch {
			return;
		}
		toast.success("A new verification code has been sent.");
	};

	const form = useForm({
		defaultValues: {
			email: "",
			password: "",
			name: "",
			plan: (initialPlan ?? "free") as CloudPlanId,
			organizationName: "",
		},
		onSubmit: async ({ value }) => {
			if (!hasDownloadedKit) {
				toast.error("Please download your Emergency Kit before continuing");
				return;
			}

			const teamName = value.organizationName.trim();
			if (isCloudSelfServeSignup && value.plan === "team" && !teamName) {
				toast.error("Please enter a team or business name to continue");
				return;
			}
			const email = getSignupEmail(value);
			const hasMatchingVerification =
				signupVerificationToken &&
				verifiedEmail === email &&
				verifiedInvitationToken === (invitationToken ?? null);
			const hasMatchingPendingVerification =
				pendingSubmission && verificationEmail.trim().toLowerCase() === email;

			if (!requiresEmailVerification) {
				await completeSignupSubmission(value, "");
				return;
			}

			if (!hasMatchingVerification || !signupVerificationToken) {
				if (hasMatchingPendingVerification) {
					setPendingSubmission(value);
					onVerificationRequested?.();
					return;
				}

				await beginSignupVerification(value);
				return;
			}

			await completeSignupSubmission(value, signupVerificationToken);
		},
	});

	const hasPendingVerification = Boolean(pendingSubmission);
	const currentSignupEmail = getSignupEmail(form.state.values);
	const hasVerifiedSignup =
		Boolean(signupVerificationToken) &&
		verifiedEmail === currentSignupEmail &&
		verifiedInvitationToken === (invitationToken ?? null);

	const downloadEmergencyKit = async () => {
		if (!secretKey || !recoveryKey) {
			toast.error("Still generating account keys. Please try again.");
			return;
		}

		const result = await downloadRecoveryKit({
			fileName: "bittery-emergency-kit",
			title: "Bittery Emergency Kit",
			subtitle:
				"Contains your Secret Key and Recovery Key for offline storage.",
			entries: [
				{
					label: "Secret Key",
					value: secretKey,
					description:
						"Required with your master password to unlock your account.",
				},
				{
					label: "Recovery Key",
					value: recoveryKey,
					description: "Required to reset your password if forgotten.",
				},
			],
			cautions: [
				"Store this kit offline in a secure location you trust.",
				"Do not save this file in shared folders or chats.",
				"If Secret Key, Recovery Key, and password are all lost, your vault cannot be recovered.",
			],
			footerNote:
				"Bittery is zero-knowledge: recovery material is generated and handled locally in your browser.",
			includeHandwrittenPasswordSection: true,
		});

		setHasDownloadedKit(true);
		if (result === "pdf-downloaded") {
			toast.success("Emergency Kit PDF downloaded.");
			return;
		}

		toast.success("PDF failed. Emergency Kit downloaded as text backup.");
	};

	const hasAllKeyMaterial = Boolean(secretKey) && Boolean(recoveryKey);

	return {
		form,
		signupMutation,
		secretKey,
		recoveryKey,
		hasDownloadedKit,
		showPassword,
		setShowPassword,
		isEncrypting,
		verificationDialogOpen,
		setVerificationDialogOpen,
		verificationCode,
		setVerificationCode,
		verificationEmail,
		hasPendingVerification,
		hasVerifiedSignup,
		requestSignupVerificationMutation,
		verifySignupVerificationMutation,
		submitSignupVerificationCode,
		resendSignupVerificationCode,
		downloadEmergencyKit,
		invitationQuery,
		registrationStatusQuery,
		invitation,
		hasInvitationToken,
		isInvitationSignup,
		isSelfHostedMode,
		isCloudMode,
		isCloudSelfServeSignup,
		isCloudBillingEnabled,
		allowPublicSignup,
		requiresEmailVerification,
		hasAllKeyMaterial,
	};
}
