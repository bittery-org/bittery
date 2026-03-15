import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	InputOTP,
	InputOTPGroup,
	InputOTPSlot,
	Label,
} from "@bittery/ui";
import {
	IconArrowLeftOutlineDuo18 as ArrowLeft,
	IconLoader2OutlineDuo18 as Loader2,
} from "@bittery/ui/icons";
import { useI18n } from "@/providers/i18n-provider";

type SignupVerificationContentProps = {
	email: string;
	code: string;
	onCodeChange: (value: string) => void;
	onVerify: () => void;
	onResend: () => void;
	isVerifying: boolean;
	isRequesting: boolean;
	verifyLabel?: string;
};

function SignupVerificationContent(props: SignupVerificationContentProps) {
	const { m } = useI18n();

	return (
		<div className="space-y-2">
			<Label htmlFor="signup-verification-code">
				{m.auth_signup_verify_code_label()}
			</Label>
			<InputOTP
				id="signup-verification-code"
				autoComplete="one-time-code"
				maxLength={6}
				value={props.code}
				onChange={(value) =>
					props.onCodeChange(value.replace(/\D/g, "").slice(0, 6))
				}
				containerClassName="justify-start"
			>
				<InputOTPGroup className="gap-1.5">
					{Array.from({ length: 6 }).map((_, index) => (
						<InputOTPSlot
							key={`signup-verification-slot-${index}`}
							index={index}
							className="h-10 w-10 rounded-xl border text-sm first:rounded-xl first:border-l last:rounded-xl"
						/>
					))}
				</InputOTPGroup>
			</InputOTP>
		</div>
	);
}

export function SignupVerificationDialog(
	props: SignupVerificationContentProps & {
		open: boolean;
		onOpenChange: (open: boolean) => void;
	},
) {
	const { m } = useI18n();

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{m.auth_signup_verify_title()}</DialogTitle>
					<DialogDescription>
						{m.auth_signup_verify_dialog_description({
							email: props.email,
						})}
					</DialogDescription>
				</DialogHeader>

				<SignupVerificationContent {...props} />

				<DialogFooter className="gap-2 sm:justify-between">
					<Button
						type="button"
						variant="ghost"
						onClick={props.onResend}
						disabled={props.isRequesting || props.isVerifying}
					>
						{props.isRequesting ? (
							<>
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								{m.auth_signup_button_sending_code()}
							</>
						) : (
							m.auth_signup_button_resend_code()
						)}
					</Button>
					<Button
						type="button"
						onClick={props.onVerify}
						disabled={props.isRequesting || props.isVerifying}
					>
						{props.isVerifying ? (
							<>
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								{m.auth_signup_button_verifying()}
							</>
						) : (
							(props.verifyLabel ??
							m.auth_signup_button_verify_and_continue())
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function SignupVerificationStep(
	props: SignupVerificationContentProps & {
		onBack: () => void;
		isFinishing: boolean;
		isPaidPlan: boolean;
		planName: string;
		planPrice: string;
		organizationName?: string;
		isVerified: boolean;
	},
) {
	const { m } = useI18n();
	const verifyButtonLabel = props.isFinishing
		? props.isPaidPlan
			? m.auth_signup_button_creating_account_and_opening_checkout()
			: m.auth_signup_button_creating_account()
		: props.isVerified
			? props.isPaidPlan
				? m.auth_signup_button_continue_to_checkout()
				: m.auth_signup_button_create_account()
			: (props.verifyLabel ??
				(props.isPaidPlan
					? m.auth_signup_button_verify_code()
					: m.auth_signup_button_verify_code()));
	const loadingButtonLabel = props.isFinishing
		? verifyButtonLabel
		: m.auth_signup_button_verifying();

	return (
		<div className="space-y-4">
			<div className="rounded-2xl border bg-muted/20 p-4">
				<p className="font-semibold text-base">
					{m.auth_signup_verify_title()}
				</p>
				<p className="mt-1 text-muted-foreground text-sm leading-relaxed">
					{props.isPaidPlan
						? m.auth_signup_verify_step_description_paid({
								email: props.email,
							})
						: m.auth_signup_verify_step_description_free({
								email: props.email,
							})}
				</p>

				<div className="mt-4 overflow-hidden rounded-xl border bg-background">
					<div className="grid divide-y divide-border/80">
						<div className="px-3.5 py-3">
							<p className="text-[11px] text-muted-foreground/70 uppercase tracking-[0.08em]">
								{m.auth_signup_verify_summary_plan()}
							</p>
							<div className="mt-1.5 flex items-baseline gap-1.5">
								<p className="font-medium text-sm">{props.planName}</p>
								<p className="text-muted-foreground text-xs">
									{props.planPrice}
								</p>
							</div>
							{props.organizationName ? (
								<p className="mt-1 text-muted-foreground text-xs">
									{props.organizationName}
								</p>
							) : null}
						</div>
						<div className="px-3.5 py-3">
							<p className="text-[11px] text-muted-foreground/70 uppercase tracking-[0.08em]">
								{m.auth_signup_verify_summary_email()}
							</p>
							<p className="mt-1.5 break-all font-medium text-sm">
								{props.email}
							</p>
						</div>
					</div>
				</div>
			</div>

			{props.isVerified ? (
				<div className="rounded-2xl border border-emerald-300/70 bg-emerald-50/50 p-4 dark:border-emerald-800/50 dark:bg-emerald-950/20">
					<p className="font-medium text-sm">
						{m.auth_signup_verify_verified_title()}
					</p>
					<p className="mt-1 text-[13px] text-emerald-700/80 leading-relaxed dark:text-emerald-400/80">
						{m.auth_signup_verify_verified_description()}
					</p>
				</div>
			) : (
				<div className="rounded-2xl border bg-background p-4">
					<div className="space-y-2.5">
						<div className="flex items-center justify-between">
							<Label htmlFor="signup-verification-step-code">
								{m.auth_signup_verify_code_label()}
							</Label>
							<Button
								type="button"
								variant="ghost"
								onClick={props.onResend}
								className="h-6 px-2 text-xs text-muted-foreground"
								disabled={
									props.isRequesting || props.isVerifying || props.isFinishing
								}
							>
								{props.isRequesting ? (
									<>
										<Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
										{m.auth_signup_button_sending_code()}
									</>
								) : (
									m.auth_signup_button_resend_code()
								)}
							</Button>
						</div>
						<InputOTP
							id="signup-verification-step-code"
							autoComplete="one-time-code"
							maxLength={6}
							value={props.code}
							onChange={(value) =>
								props.onCodeChange(value.replace(/\D/g, "").slice(0, 6))
							}
							containerClassName="justify-start"
						>
							<InputOTPGroup className="gap-1.5">
								{Array.from({ length: 6 }).map((_, index) => (
									<InputOTPSlot
										key={`signup-verification-step-slot-${index}`}
										index={index}
										className="h-11 w-11 rounded-xl border text-base first:rounded-xl first:border-l last:rounded-xl"
									/>
								))}
							</InputOTPGroup>
						</InputOTP>
					</div>
				</div>
			)}

			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<Button
					type="button"
					variant="ghost"
					onClick={props.onBack}
					className="h-9 justify-start gap-1.5 px-3 text-muted-foreground sm:w-auto"
					disabled={
						props.isRequesting || props.isVerifying || props.isFinishing
					}
				>
					<ArrowLeft size={14} />
					{m.auth_signup_button_back()}
				</Button>

				<Button
					type="button"
					onClick={props.onVerify}
					className="h-10 rounded-2xl px-5 sm:w-auto"
					disabled={
						props.isRequesting || props.isVerifying || props.isFinishing
					}
				>
					{props.isVerifying || props.isFinishing ? (
						<>
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							{loadingButtonLabel}
						</>
					) : (
						verifyButtonLabel
					)}
				</Button>
			</div>
		</div>
	);
}
