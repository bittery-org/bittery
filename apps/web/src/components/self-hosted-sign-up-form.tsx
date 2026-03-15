import { Badge, Button, cn, Input, Label } from "@bittery/ui";
import {
	IconCircleCheck2OutlineDuo18 as CheckCircle2,
	IconClipboardArrowInOutlineDuo18 as Download,
	IconEyeOutlineDuo18 as Eye,
	IconEyeSlashOutlineDuo18 as EyeOff,
	IconLoader2OutlineDuo18 as Loader2,
	IconUsers6OutlineDuo18 as Users,
} from "@bittery/ui/icons";
import { useSignupForm } from "@/hooks/use-signup-form";
import { useI18n } from "@/providers/i18n-provider";
import { SignupVerificationDialog } from "./signup-verification-dialog";

export default function SelfHostedSignUpForm({
	onSwitchToSignIn,
	invitationToken,
	redirectTo,
}: {
	onSwitchToSignIn: () => void;
	invitationToken?: string;
	redirectTo?: string;
}) {
	const { m } = useI18n();
	const {
		form,
		signupMutation,
		hasDownloadedKit,
		showPassword,
		setShowPassword,
		isEncrypting,
		verificationDialogOpen,
		setVerificationDialogOpen,
		verificationCode,
		setVerificationCode,
		verificationEmail,
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
		allowPublicSignup,
		hasAllKeyMaterial,
	} = useSignupForm({ invitationToken, redirectTo });

	const signupHeading = isInvitationSignup
		? m.auth_self_hosted_title_accept_invitation()
		: m.auth_self_hosted_title_create_admin();
	const signupDescription = isInvitationSignup
		? m.auth_self_hosted_description_accept_invitation()
		: m.auth_self_hosted_description_create_admin();

	if (hasInvitationToken && invitationQuery.isError) {
		return (
			<div className="w-full">
				<h1 className="text-center font-semibold text-2xl tracking-tight">
					{m.auth_self_hosted_invitation_required_title()}
				</h1>
				<div className="mt-6 space-y-4">
					<p className="text-muted-foreground text-sm leading-relaxed">
						{m.auth_self_hosted_invitation_required_description()}
					</p>
					<Button type="button" onClick={onSwitchToSignIn} className="w-full">
						{m.auth_signup_button_back_to_signin()}
					</Button>
				</div>
			</div>
		);
	}

	if (hasInvitationToken && invitationQuery.isLoading) {
		return (
			<div className="w-full">
				<h1 className="text-center font-semibold text-2xl tracking-tight">
					{m.auth_self_hosted_loading_invitation_title()}
				</h1>
				<div className="mt-6 flex items-center justify-center gap-2 text-muted-foreground text-sm">
					<Loader2 className="h-4 w-4 animate-spin" />
					{m.auth_self_hosted_loading_invitation_description()}
				</div>
			</div>
		);
	}

	if (
		!hasInvitationToken &&
		!registrationStatusQuery.isLoading &&
		!allowPublicSignup
	) {
		return (
			<div className="w-full">
				<h1 className="text-center font-semibold text-2xl tracking-tight">
					{m.auth_signup_invite_only_title()}
				</h1>
				<div className="mt-6 space-y-4">
					<p className="text-muted-foreground text-sm leading-relaxed">
						{m.auth_signup_invite_only_description()}
					</p>
					<Button type="button" onClick={onSwitchToSignIn} className="w-full">
						{m.auth_signup_button_back_to_signin()}
					</Button>
				</div>
			</div>
		);
	}

	return (
		<>
			<div className="w-full">
				<h1 className="text-center font-semibold text-2xl tracking-tight">
					{signupHeading}
				</h1>
				<p className="mx-auto mt-2 max-w-80 text-center text-muted-foreground text-sm">
					{signupDescription}
				</p>
				<div className="mt-6">
					<form
						onSubmit={(e) => {
							e.preventDefault();
							e.stopPropagation();
							form.handleSubmit();
						}}
						className="space-y-4"
					>
					{isInvitationSignup ? (
						<div className="rounded-lg border bg-muted/30 p-4">
							<div className="flex items-start gap-3">
								<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
									<Users className="h-5 w-5 text-primary" />
								</div>
								<div className="space-y-1">
									<p className="font-medium text-sm">
										{m.auth_self_hosted_invited_to_join({
											teamName: invitation?.teamName ?? "",
										})}
									</p>
									<div className="flex items-center gap-2 text-muted-foreground text-xs">
										<span>
											{m.auth_self_hosted_invited_by({
												invitedByName: invitation?.invitedByName ?? "",
											})}
										</span>
										<span>·</span>
										<Badge variant="secondary" className="text-xs">
											{invitation?.role}
										</Badge>
									</div>
								</div>
							</div>
						</div>
					) : null}

					<div>
						<form.Field name="name">
							{(field) => (
								<div className="space-y-2">
									<Label htmlFor={field.name}>
										{m.auth_signup_form_full_name()}
									</Label>
									<Input
										id={field.name}
										name={field.name}
										placeholder={m.auth_signup_form_full_name_placeholder()}
										value={field.state.value}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value)}
										required
										className="h-10"
									/>
								</div>
							)}
						</form.Field>
					</div>

					<div>
						<form.Field name="email">
							{(field) => (
								<div className="space-y-2">
									<Label htmlFor={field.name}>
										{m.auth_signup_form_email()}
									</Label>
									<Input
										id={field.name}
										name={field.name}
										type="email"
										placeholder={m.auth_signup_form_email_placeholder()}
										value={
											isInvitationSignup
												? invitation?.email || field.state.value
												: field.state.value
										}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value)}
										required
										disabled={isInvitationSignup}
										className="h-10"
									/>
									{isInvitationSignup && (
										<p className="text-muted-foreground text-xs">
											{m.auth_self_hosted_email_locked()}
										</p>
									)}
								</div>
							)}
						</form.Field>
					</div>

					<div>
						<form.Field name="password">
							{(field) => (
								<div className="space-y-2">
									<Label htmlFor={field.name}>
										{m.auth_signup_form_master_password()}
									</Label>
									<div className="relative">
										<Input
											id={field.name}
											name={field.name}
											type={showPassword ? "text" : "password"}
											value={field.state.value}
											onBlur={field.handleBlur}
											onChange={(e) => field.handleChange(e.target.value)}
											required
											className="h-10 pr-10"
										/>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="absolute top-0 right-0 h-10 w-10 text-muted-foreground hover:text-foreground"
											onClick={() => setShowPassword(!showPassword)}
										>
											{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
										</Button>
									</div>
									<p className="text-[0.8rem] text-muted-foreground">
										{m.auth_signup_form_master_password_help()}
									</p>
								</div>
							)}
						</form.Field>
					</div>

					<button
						type="button"
						disabled={!hasAllKeyMaterial}
						onClick={downloadEmergencyKit}
						className={cn(
							"flex w-full items-center gap-2.5 rounded-lg border px-3.5 py-3 text-left transition-colors",
							hasDownloadedKit
								? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/40 dark:bg-emerald-950/20"
								: "hover:bg-muted/50",
						)}
					>
						{hasDownloadedKit ? (
							<CheckCircle2
								size={16}
								className="shrink-0 text-emerald-600 dark:text-emerald-400"
							/>
						) : (
							<Download size={16} className="shrink-0 text-muted-foreground" />
						)}
						<div className="min-w-0 flex-1">
							<p className="font-medium text-sm">
								{hasDownloadedKit
									? m.auth_signup_emergency_kit_saved_title()
									: m.auth_signup_emergency_kit_download_title()}
							</p>
							<p className="text-muted-foreground text-xs">
								{m.auth_self_hosted_emergency_kit_description()}
							</p>
						</div>
					</button>

					<div className="pt-1">
						<Button
							type="submit"
							className="h-10 w-full"
							disabled={
								isEncrypting || signupMutation.isPending || !hasDownloadedKit
							}
						>
							{isEncrypting || signupMutation.isPending ? (
								<>
									<Loader2 size={16} className="mr-2 animate-spin" />
									{isEncrypting
										? m.auth_signup_button_setting_up_encryption()
										: m.auth_signup_button_creating_account()}
								</>
							) : !hasDownloadedKit ? (
								<>
									<Download size={16} className="mr-2" />
									{m.auth_signup_button_download_kit_to_continue()}
								</>
							) : (
								m.auth_signup_button_create_account()
							)}
						</Button>
					</div>

					<Button
						type="button"
						variant="ghost"
						onClick={onSwitchToSignIn}
						className="w-full"
					>
						{m.auth_signup_button_have_account()}
					</Button>
					</form>
				</div>
			</div>
			<SignupVerificationDialog
				open={verificationDialogOpen}
				email={verificationEmail}
				code={verificationCode}
				onCodeChange={setVerificationCode}
				onOpenChange={setVerificationDialogOpen}
				onVerify={submitSignupVerificationCode}
				onResend={resendSignupVerificationCode}
				isVerifying={verifySignupVerificationMutation.isPending}
				isRequesting={requestSignupVerificationMutation.isPending}
			/>
		</>
	);
}
