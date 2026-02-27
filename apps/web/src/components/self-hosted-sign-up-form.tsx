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

export default function SelfHostedSignUpForm({
	onSwitchToSignIn,
	invitationToken,
	redirectTo,
}: {
	onSwitchToSignIn: () => void;
	invitationToken?: string;
	redirectTo?: string;
}) {
	const {
		form,
		signupMutation,
		hasDownloadedKit,
		showPassword,
		setShowPassword,
		isEncrypting,
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
		? "Accept Invitation"
		: "Create admin account";
	const signupDescription = isInvitationSignup
		? "Create your account to securely join the invited workspace."
		: "Set up the first admin account for this server.";

	if (hasInvitationToken && invitationQuery.isError) {
		return (
			<div className="w-full">
				<h1 className="text-center font-semibold text-2xl tracking-tight">
					Invitation Required
				</h1>
				<div className="mt-6 space-y-4">
					<p className="text-muted-foreground text-sm leading-relaxed">
						This invitation link is invalid or expired. Ask your admin to
						send a new invite link.
					</p>
					<Button
						type="button"
						onClick={onSwitchToSignIn}
						className="w-full"
					>
						Back to Sign In
					</Button>
				</div>
			</div>
		);
	}

	if (hasInvitationToken && invitationQuery.isLoading) {
		return (
			<div className="w-full">
				<h1 className="text-center font-semibold text-2xl tracking-tight">
					Loading invitation
				</h1>
			<div className="mt-6 flex items-center justify-center gap-2 text-muted-foreground text-sm">
				<Loader2 className="h-4 w-4 animate-spin" />
				Verifying invitation link...
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
					Invite-Only Registration
				</h1>
				<div className="mt-6 space-y-4">
					<p className="text-muted-foreground text-sm leading-relaxed">
						Registration is closed on this server. Ask an admin for an
						invite link.
					</p>
					<Button
						type="button"
						onClick={onSwitchToSignIn}
						className="w-full"
					>
						Back to Sign In
					</Button>
				</div>
			</div>
		);
	}

	return (
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
						<div>
							<form.Field name="name">
								{(field) => (
									<div className="space-y-2">
										<Label htmlFor={field.name}>Full Name</Label>
										<Input
											id={field.name}
											name={field.name}
											placeholder="John Doe"
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

						{isInvitationSignup ? (
							<div className="rounded-lg border bg-muted/30 p-4">
								<div className="flex items-start gap-3">
									<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
										<Users className="h-5 w-5 text-primary" />
									</div>
									<div className="space-y-1">
										<p className="font-medium text-sm">
											You've been invited to join{" "}
											<span className="text-primary">
												{invitation?.teamName}
											</span>
										</p>
										<div className="flex items-center gap-2 text-muted-foreground text-xs">
											<span>Invited by {invitation?.invitedByName}</span>
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
							<form.Field name="email">
								{(field) => (
									<div className="space-y-2">
										<Label htmlFor={field.name}>Email</Label>
										<Input
											id={field.name}
											name={field.name}
											type="email"
											placeholder="name@example.com"
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
												This email was used to invite you and cannot be changed.
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
										<Label htmlFor={field.name}>Master Password</Label>
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
												{showPassword ? (
													<EyeOff size={16} />
												) : (
													<Eye size={16} />
												)}
											</Button>
										</div>
										<p className="text-[0.8rem] text-muted-foreground">
											Must be at least 8 characters long.
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
								<Download
									size={16}
									className="shrink-0 text-muted-foreground"
								/>
							)}
							<div className="min-w-0 flex-1">
								<p className="font-medium text-sm">
									{hasDownloadedKit
										? "Emergency Kit saved"
										: "Download Emergency Kit"}
								</p>
								<p className="text-muted-foreground text-xs">
									Secret Key & Recovery Key for account recovery
								</p>
							</div>
						</button>

						<div className="pt-1">
							<Button
								type="submit"
								className="h-10 w-full"
								disabled={
									isEncrypting ||
									signupMutation.isPending ||
									!hasDownloadedKit
								}
							>
								{isEncrypting || signupMutation.isPending ? (
									<>
										<Loader2 size={16} className="mr-2 animate-spin" />
										{isEncrypting
											? "Setting up encryption..."
											: "Creating account..."}
									</>
								) : !hasDownloadedKit ? (
									<>
										<Download size={16} className="mr-2" />
										Download Emergency Kit to continue
									</>
								) : (
									"Create Account"
								)}
							</Button>
						</div>

						<Button
							type="button"
							variant="ghost"
							onClick={onSwitchToSignIn}
							className="w-full"
						>
							Already have an account? Sign in
						</Button>
				</form>
			</div>
		</div>
	);
}
