import { type CloudPlanId, planInfo } from "@bittery/shared/pricing";
import { Badge, Button, cn, Input, Label, toast } from "@bittery/ui";
import {
	IconArrowLeftOutlineDuo18 as ArrowLeft,
	IconSuitcase3OutlineDuo18 as Briefcase,
	IconCheckOutlineDuo18 as Check,
	IconCircleCheck2OutlineDuo18 as CheckCircle2,
	IconClipboardArrowInOutlineDuo18 as Download,
	IconEyeOutlineDuo18 as Eye,
	IconEyeSlashOutlineDuo18 as EyeOff,
	IconHeartOutlineDuo18 as Heart,
	IconLoader2OutlineDuo18 as Loader2,
	IconLockOutlineDuo18 as Lock,
	IconMagicShieldOutlineDuo18 as Shield,
	IconStarSparkle2OutlineDuo18 as Sparkle,
} from "@bittery/ui/icons";
import { useState } from "react";
import { useSignupForm } from "@/hooks/use-signup-form";
import { useI18n } from "@/providers/i18n-provider";
import PlanComparisonDialog from "./plan-comparison-dialog";
import SelfHostedSignUpForm from "./self-hosted-sign-up-form";
import { SignupVerificationStep } from "./signup-verification-dialog";

const planIcons: Record<
	CloudPlanId,
	React.ComponentType<{ size?: number; className?: string }>
> = {
	free: Lock,
	personal: Sparkle,
	family: Heart,
	team: Briefcase,
};

const planStyles: Record<
	CloudPlanId,
	{ accentClass: string; iconBgClass: string }
> = {
	free: {
		accentClass: "border-border dark:border-border",
		iconBgClass: "bg-muted text-muted-foreground",
	},
	personal: {
		accentClass: "border-primary/60 dark:border-primary/40",
		iconBgClass: "bg-primary/10 text-primary",
	},
	family: {
		accentClass: "border-amber-300/60 dark:border-amber-500/30",
		iconBgClass:
			"bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400",
	},
	team: {
		accentClass: "border-sky-300/60 dark:border-sky-500/30",
		iconBgClass: "bg-sky-50 text-sky-600 dark:bg-sky-500/10 dark:text-sky-400",
	},
};

const cloudPlans = planInfo.map((plan) => ({
	...plan,
	icon: planIcons[plan.id],
	...planStyles[plan.id],
}));

const validPlanIds = new Set<string>(["free", "personal", "family", "team"]);

export default function SignUpForm({
	onSwitchToSignIn,
	invitationToken,
	redirectTo,
	initialPlan,
}: {
	onSwitchToSignIn: () => void;
	invitationToken?: string;
	redirectTo?: string;
	initialPlan?: string;
}) {
	const { m } = useI18n();
	const resolvedPlan =
		initialPlan && validPlanIds.has(initialPlan)
			? (initialPlan as CloudPlanId)
			: undefined;
	const [cloudSignupStep, setCloudSignupStep] = useState<
		"plan" | "account" | "verify"
	>(resolvedPlan ? "account" : "plan");
	const signup = useSignupForm({
		invitationToken,
		redirectTo,
		initialPlan: resolvedPlan,
		verificationMode: "inline",
		onVerificationRequested: () => setCloudSignupStep("verify"),
	});

	// Delegate to self-hosted component for self-hosted or invitation flows
	if (signup.isSelfHostedMode || signup.isInvitationSignup) {
		return (
			<SelfHostedSignUpForm
				onSwitchToSignIn={onSwitchToSignIn}
				invitationToken={invitationToken}
				redirectTo={redirectTo}
			/>
		);
	}

	// Guard states for cloud mode
	if (
		!signup.hasInvitationToken &&
		!signup.registrationStatusQuery.isLoading &&
		!signup.allowPublicSignup
	) {
		return (
			<div className="w-full">
				<h1 className="text-center font-semibold text-2xl tracking-tight">
					{m.auth_signup_invite_only_title()}
				</h1>
				<div className="mt-6 rounded-2xl border bg-card p-6">
					<div className="space-y-4">
						<p className="text-muted-foreground text-sm leading-relaxed">
							{m.auth_signup_invite_only_description()}
						</p>
						<Button type="button" onClick={onSwitchToSignIn} className="w-full">
							{m.auth_signup_button_back_to_signin()}
						</Button>
					</div>
				</div>
			</div>
		);
	}

	const showPlanStep = cloudSignupStep === "plan";
	const showAccountStep = cloudSignupStep === "account";
	const showVerifyStep = cloudSignupStep === "verify";
	const isFlowLocked =
		signup.requestSignupVerificationMutation.isPending ||
		signup.verifySignupVerificationMutation.isPending ||
		signup.isEncrypting ||
		signup.signupMutation.isPending;

	return (
		<div className="w-full">
			<div className="text-center">
				<h1 className="font-semibold text-2xl tracking-tight">
					{showPlanStep
						? m.auth_signup_header_choose_plan()
						: showAccountStep
							? m.auth_signup_header_create_account()
							: m.auth_signup_header_verify_email()}
				</h1>
				<p className="mx-auto mt-2 max-w-80 text-muted-foreground text-sm">
					{showPlanStep
						? m.auth_signup_subheader_choose_plan()
						: showAccountStep
							? m.auth_signup_subheader_create_account()
							: m.auth_signup_subheader_verify_email()}
				</p>
			</div>

			<div className="mt-6">
				<div className="relative flex h-10 rounded-xl border bg-muted/40 p-1">
					<div
						className={cn(
							"absolute top-1 bottom-1 w-[calc(33.333%-6px)] rounded-lg bg-background shadow-sm transition-all duration-300 ease-out",
							showPlanStep
								? "left-1"
								: showAccountStep
									? "left-[calc(33.333%+1px)]"
									: "left-[calc(66.666%+1px)]",
						)}
					/>
					<button
						type="button"
						className={cn(
							"relative z-10 flex flex-1 items-center justify-center gap-2 rounded-lg font-medium text-xs transition-colors duration-200",
							showPlanStep
								? "text-foreground"
								: "text-muted-foreground hover:text-foreground/70",
						)}
						onClick={() => setCloudSignupStep("plan")}
						disabled={isFlowLocked}
					>
						{showPlanStep ? (
							<span className="flex h-4 w-4 items-center justify-center rounded-full border border-primary/50 bg-primary/10 font-bold text-[10px] text-primary">
								1
							</span>
						) : (
							<span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
								<Check size={10} />
							</span>
						)}
						{m.auth_signup_step_plan()}
					</button>
					<button
						type="button"
						className={cn(
							"relative z-10 flex flex-1 items-center justify-center gap-2 rounded-lg font-medium text-xs transition-colors duration-200",
							showAccountStep
								? "text-foreground"
								: "text-muted-foreground hover:text-foreground/70",
						)}
						onClick={() => setCloudSignupStep("account")}
						disabled={showPlanStep || isFlowLocked}
					>
						{showVerifyStep ? (
							<span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
								<Check size={10} />
							</span>
						) : (
							<span
								className={cn(
									"flex h-4 w-4 items-center justify-center rounded-full font-bold text-[10px] transition-colors duration-200",
									showAccountStep
										? "border border-primary/50 bg-primary/10 text-primary"
										: "border border-border text-muted-foreground",
								)}
							>
								2
							</span>
						)}
						{m.auth_signup_step_account()}
					</button>
					<button
						type="button"
						className={cn(
							"relative z-10 flex flex-1 items-center justify-center gap-2 rounded-lg font-medium text-xs transition-colors duration-200",
							showVerifyStep ? "text-foreground" : "text-muted-foreground",
						)}
						disabled={!showVerifyStep || isFlowLocked}
					>
						<span
							className={cn(
								"flex h-4 w-4 items-center justify-center rounded-full font-bold text-[10px] transition-colors duration-200",
								showVerifyStep
									? "border border-primary/50 bg-primary/10 text-primary"
									: "border border-border text-muted-foreground",
							)}
						>
							3
						</span>
						{m.auth_signup_step_verify()}
					</button>
				</div>
			</div>

			<div className="mt-5">
				{showPlanStep ? (
					<PlanSelectionStep
						m={m}
						form={signup.form}
						onContinue={() => setCloudSignupStep("account")}
						onSwitchToSignIn={onSwitchToSignIn}
					/>
				) : showAccountStep ? (
					<AccountSetupStep
						m={m}
						signup={signup}
						onBack={() => setCloudSignupStep("plan")}
						onSwitchToSignIn={onSwitchToSignIn}
					/>
				) : (
					<VerificationStep
						signup={signup}
						onBack={() => setCloudSignupStep("account")}
					/>
				)}
			</div>
		</div>
	);
}

/* ─── Plan Selection Step ──────────────────────────────────────────── */

function PlanSelectionStep({
	m,
	form,
	onContinue,
	onSwitchToSignIn,
}: {
	m: ReturnType<typeof useI18n>["m"];
	form: ReturnType<typeof useSignupForm>["form"];
	onContinue: () => void;
	onSwitchToSignIn: () => void;
}) {
	const [showComparison, setShowComparison] = useState(false);

	return (
		<div className="space-y-4">
			<form.Field name="plan">
				{(field) => (
					<div className="grid grid-cols-2 gap-2.5">
						{cloudPlans.map((plan) => {
							const isSelected = field.state.value === plan.id;
							const Icon = plan.icon;

							return (
								<button
									key={plan.id}
									type="button"
									className={cn(
										"group relative flex flex-col rounded-xl border-2 p-3.5 text-left transition-all duration-200",
										isSelected
											? cn(
													plan.accentClass,
													"bg-card shadow-sm",
													plan.isRecommended && "ring-2 ring-primary/15",
												)
											: "border-transparent bg-muted/50 hover:border-border hover:bg-muted/70",
									)}
									onClick={() => field.handleChange(plan.id)}
								>
									{/* Recommended badge */}
									{plan.isRecommended && (
										<div className="absolute -top-2.5 right-3">
											<Badge
												variant="default"
												className="h-5 rounded-full px-2 font-medium text-[10px] shadow-sm"
											>
												{m.auth_signup_plan_popular()}
											</Badge>
										</div>
									)}

									{/* Icon + Selection indicator */}
									<div className="flex items-center justify-between">
										<div
											className={cn(
												"flex h-8 w-8 items-center justify-center rounded-lg transition-colors duration-200",
												isSelected
													? plan.iconBgClass
													: "bg-muted text-muted-foreground",
											)}
										>
											<Icon size={16} />
										</div>
										<span
											className={cn(
												"flex h-4.5 w-4.5 items-center justify-center rounded-full border-2 transition-all duration-200",
												isSelected
													? "scale-100 border-primary bg-primary text-primary-foreground"
													: "scale-90 border-border bg-background opacity-50 group-hover:scale-100 group-hover:opacity-80",
											)}
										>
											{isSelected ? <Check size={10} /> : null}
										</span>
									</div>

									{/* Content */}
									<div className="mt-3 space-y-1">
										<p className="font-semibold text-sm leading-none">
											{plan.name}
										</p>
										<p
											className={cn(
												"text-[11px] leading-snug",
												isSelected
													? "text-muted-foreground"
													: "text-muted-foreground/70",
											)}
										>
											{plan.description}
										</p>
									</div>

									{/* Price */}
									<div className="mt-3 flex items-baseline gap-0.5">
										<span
											className={cn(
												"font-bold text-lg leading-none tracking-tight",
												isSelected ? "text-foreground" : "text-foreground/70",
											)}
										>
											{plan.priceLabel}
										</span>
										{plan.priceSuffix && (
											<span className="text-[11px] text-muted-foreground">
												{plan.priceSuffix}
											</span>
										)}
									</div>
								</button>
							);
						})}
					</div>
				)}
			</form.Field>

			{/* Compare plans link */}
			<form.Subscribe selector={(state) => state.values.plan}>
				{(selectedPlan) => (
					<>
						<button
							type="button"
							onClick={() => setShowComparison(true)}
							className="flex w-full items-center justify-center gap-1.5 py-1 text-muted-foreground text-xs transition-colors hover:text-foreground"
						>
							<span className="border-current border-b border-dashed">
								{m.auth_signup_compare_all_plans()}
							</span>
						</button>
						<PlanComparisonDialog
							open={showComparison}
							onOpenChange={setShowComparison}
							selectedPlan={selectedPlan}
							onSelectPlan={(id) => form.setFieldValue("plan", id)}
						/>
					</>
				)}
			</form.Subscribe>

			{/* Team name input (conditional) */}
			<form.Subscribe selector={(state) => state.values.plan}>
				{(selectedPlan) =>
					selectedPlan === "team" ? (
						<form.Field name="organizationName">
							{(field) => (
								<div className="space-y-2 rounded-xl border bg-muted/20 p-3.5">
									<Label htmlFor={field.name} className="text-xs">
										{m.auth_signup_team_name_label()}
									</Label>
									<Input
										id={field.name}
										name={field.name}
										placeholder={m.auth_signup_team_name_placeholder()}
										value={field.state.value}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value)}
										required
										className="h-9"
									/>
									<p className="text-[11px] text-muted-foreground/70">
										{m.auth_signup_team_name_help()}
									</p>
								</div>
							)}
						</form.Field>
					) : null
				}
			</form.Subscribe>

			{/* Continue CTA */}
			<form.Subscribe
				selector={(state) => ({
					organizationName: state.values.organizationName,
					plan: state.values.plan,
				})}
			>
				{({ plan, organizationName }) => (
					<Button
						type="button"
						className="h-10 w-full bg-primary font-medium shadow-sm"
						onClick={() => {
							if (plan === "team" && !organizationName.trim()) {
								toast.error(m.auth_signup_error_team_name_required());
								return;
							}
							onContinue();
						}}
					>
						{m.auth_signup_button_continue()}
					</Button>
				)}
			</form.Subscribe>

			<Button
				type="button"
				variant="ghost"
				onClick={onSwitchToSignIn}
				className="w-full text-muted-foreground"
			>
				{m.auth_signup_button_have_account()}
			</Button>
		</div>
	);
}

/* ─── Account Setup Step ───────────────────────────────────────────── */

function AccountSetupStep({
	m,
	signup,
	onBack,
	onSwitchToSignIn,
}: {
	m: ReturnType<typeof useI18n>["m"];
	signup: ReturnType<typeof useSignupForm>;
	onBack: () => void;
	onSwitchToSignIn: () => void;
}) {
	const {
		form,
		signupMutation,
		hasDownloadedKit,
		showPassword,
		setShowPassword,
		isEncrypting,
		downloadEmergencyKit,
		hasAllKeyMaterial,
		hasVerifiedSignup,
		requestSignupVerificationMutation,
	} = signup;

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				e.stopPropagation();
				form.handleSubmit();
			}}
			className="space-y-4"
		>
			{/* Plan summary chip */}
			<form.Subscribe
				selector={(state) => ({
					organizationName: state.values.organizationName,
					plan: state.values.plan,
				})}
			>
				{({ plan, organizationName }) => {
					const selectedPlan = cloudPlans.find((p) => p.id === plan);
					if (!selectedPlan) return null;
					const Icon = selectedPlan.icon;

					return (
						<div className="flex items-center justify-between rounded-xl border bg-muted/25 px-3.5 py-2.5">
							<div className="flex items-center gap-2.5">
								<div
									className={cn(
										"flex h-7 w-7 items-center justify-center rounded-lg",
										selectedPlan.iconBgClass,
									)}
								>
									<Icon size={14} />
								</div>
								<div>
									<p className="font-medium text-sm leading-none">
										{selectedPlan.name}
									</p>
									<p className="mt-0.5 text-[11px] text-muted-foreground">
										{selectedPlan.priceLabel}
										{selectedPlan.priceSuffix || ""}
										{plan === "team" && organizationName.trim()
											? ` · ${organizationName.trim()}`
											: ""}
									</p>
								</div>
							</div>
							<button
								type="button"
								onClick={onBack}
								className="rounded-lg px-2.5 py-1 font-medium text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
							>
								{m.auth_signup_summary_change()}
							</button>
						</div>
					);
				}}
			</form.Subscribe>

			{/* Name field */}
			<form.Field name="name">
				{(field) => (
					<div className="space-y-1.5">
						<Label htmlFor={field.name} className="font-medium text-xs">
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

			{/* Email field */}
			<form.Field name="email">
				{(field) => (
					<div className="space-y-1.5">
						<Label htmlFor={field.name} className="font-medium text-xs">
							{m.auth_signup_form_email()}
						</Label>
						<Input
							id={field.name}
							name={field.name}
							type="email"
							placeholder={m.auth_signup_form_email_placeholder()}
							value={field.state.value}
							onBlur={field.handleBlur}
							onChange={(e) => field.handleChange(e.target.value)}
							required
							className="h-10"
						/>
					</div>
				)}
			</form.Field>

			{/* Password field */}
			<form.Field name="password">
				{(field) => (
					<div className="space-y-1.5">
						<Label htmlFor={field.name} className="font-medium text-xs">
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
						<p className="text-[11px] text-muted-foreground/70">
							{m.auth_signup_form_master_password_help()}
						</p>
					</div>
				)}
			</form.Field>

			{/* Emergency Kit — distinctive card */}
			<button
				type="button"
				disabled={!hasAllKeyMaterial}
				onClick={downloadEmergencyKit}
				className={cn(
					"group relative flex w-full items-center gap-3 overflow-hidden rounded-xl border px-4 py-3.5 text-left transition-all duration-200",
					hasDownloadedKit
						? "border-emerald-300/70 bg-emerald-50/40 dark:border-emerald-800/50 dark:bg-emerald-950/20"
						: "border-border border-dashed hover:border-primary/40 hover:bg-primary/2",
				)}
			>
				{/* Shield icon container */}
				<div
					className={cn(
						"flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors duration-200",
						hasDownloadedKit
							? "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400"
							: "bg-muted/60 text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary",
					)}
				>
					{hasDownloadedKit ? <CheckCircle2 size={18} /> : <Shield size={18} />}
				</div>

				<div className="min-w-0 flex-1">
					<p className="font-medium text-sm leading-none">
						{hasDownloadedKit
							? m.auth_signup_emergency_kit_saved_title()
							: m.auth_signup_emergency_kit_download_title()}
					</p>
					<p
						className={cn(
							"mt-1 text-[11px] leading-snug",
							hasDownloadedKit
								? "text-emerald-700/70 dark:text-emerald-400/60"
								: "text-muted-foreground/70",
						)}
					>
						{hasDownloadedKit
							? m.auth_signup_emergency_kit_saved_description()
							: m.auth_signup_emergency_kit_required_description()}
					</p>
				</div>

				{!hasDownloadedKit && (
					<Download
						size={16}
						className="shrink-0 text-muted-foreground/50 transition-colors group-hover:text-primary"
					/>
				)}
			</button>

			{/* Submit */}
			<div className="pt-1">
				<Button
					type="submit"
					className="h-10 w-full font-medium shadow-sm"
					disabled={
						isEncrypting ||
						signupMutation.isPending ||
						requestSignupVerificationMutation.isPending ||
						!hasDownloadedKit
					}
				>
					{isEncrypting || signupMutation.isPending ? (
						<>
							<Loader2 size={16} className="mr-2 animate-spin" />
							{isEncrypting
								? m.auth_signup_button_setting_up_encryption()
								: m.auth_signup_button_creating_account()}
						</>
					) : requestSignupVerificationMutation.isPending ? (
						<>
							<Loader2 size={16} className="mr-2 animate-spin" />
							{m.auth_signup_button_sending_verification_code()}
						</>
					) : !hasDownloadedKit ? (
						<>
							<Shield size={16} className="mr-2" />
							{m.auth_signup_button_download_kit_to_continue()}
						</>
					) : hasVerifiedSignup ? (
						m.auth_signup_button_create_account()
					) : (
						m.auth_signup_button_continue_to_verification()
					)}
				</Button>
			</div>

			<div className="flex items-center gap-2">
				<Button
					type="button"
					variant="ghost"
					onClick={onBack}
					className="h-9 gap-1.5 px-3 text-muted-foreground"
				>
					<ArrowLeft size={14} />
					{m.auth_signup_button_back()}
				</Button>
				<div className="h-4 w-px bg-border" />
				<Button
					type="button"
					variant="ghost"
					onClick={onSwitchToSignIn}
					className="flex-1 text-muted-foreground"
				>
					{m.auth_signup_button_have_account()}
				</Button>
			</div>
		</form>
	);
}

function VerificationStep({
	signup,
	onBack,
}: {
	signup: ReturnType<typeof useSignupForm>;
	onBack: () => void;
}) {
	const { form } = signup;

	return (
		<form.Subscribe
			selector={(state) => ({
				organizationName: state.values.organizationName,
				plan: state.values.plan,
			})}
		>
			{({ plan, organizationName }) => {
				const selectedPlan = cloudPlans.find((item) => item.id === plan);
				if (!selectedPlan) {
					return null;
				}

				return (
					<SignupVerificationStep
						email={signup.verificationEmail}
						code={signup.verificationCode}
						onCodeChange={signup.setVerificationCode}
						onVerify={signup.submitSignupVerificationCode}
						onResend={signup.resendSignupVerificationCode}
						onBack={onBack}
						isVerifying={signup.verifySignupVerificationMutation.isPending}
						isRequesting={signup.requestSignupVerificationMutation.isPending}
						isFinishing={signup.isEncrypting || signup.signupMutation.isPending}
						isPaidPlan={selectedPlan.id !== "free"}
						planName={selectedPlan.name}
						planPrice={`${selectedPlan.priceLabel}${selectedPlan.priceSuffix || ""}`}
						organizationName={
							plan === "team" && organizationName.trim()
								? organizationName.trim()
								: undefined
						}
						isVerified={signup.hasVerifiedSignup}
					/>
				);
			}}
		</form.Subscribe>
	);
}
