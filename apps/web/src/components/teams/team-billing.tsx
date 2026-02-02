import {
	Badge,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Progress,
} from "@bittery/ui";
import {
	CreditCard,
	Download,
	ExternalLink,
	FileText,
	Sparkles,
	Users,
	Zap,
} from "lucide-react";

interface TeamBillingProps {
	teamId: string;
	teamName: string;
	memberCount: number;
	userRole: string;
}

export function TeamBilling({
	teamName,
	memberCount,
	userRole,
}: TeamBillingProps) {
	const canManageBilling = userRole === "owner";

	// Placeholder data for the billing UI
	const currentPlan = {
		name: "Free",
		price: 0,
		memberLimit: 3,
		storageLimit: 100, // MB
		storageUsed: 45, // MB
	};

	const plans = [
		{
			name: "Free",
			price: 0,
			features: ["Up to 3 team members", "100 MB storage", "Basic support"],
			current: true,
		},
		{
			name: "Team",
			price: 8,
			features: [
				"Up to 10 team members",
				"1 GB storage",
				"Priority support",
				"Advanced permissions",
			],
			recommended: true,
		},
		{
			name: "Organization",
			price: 15,
			features: [
				"Unlimited team members",
				"10 GB storage",
				"24/7 support",
				"SSO integration",
				"Audit logs",
			],
		},
	];

	const invoices = [
		{
			id: "inv_001",
			date: "Jan 1, 2024",
			amount: 0,
			status: "paid",
		},
	];

	return (
		<div className="space-y-6">
			{/* Current Plan Card */}
			<Card>
				<CardHeader>
					<div className="flex items-center justify-between">
						<div>
							<CardTitle className="flex items-center gap-2">
								<Zap className="h-5 w-5 text-primary" />
								Current Plan
							</CardTitle>
							<CardDescription>
								Manage your team's subscription and billing
							</CardDescription>
						</div>
						<Badge variant="secondary" className="text-sm">
							{currentPlan.name}
						</Badge>
					</div>
				</CardHeader>
				<CardContent className="space-y-6">
					{/* Usage Stats */}
					<div className="grid gap-4 md:grid-cols-2">
						<div className="space-y-2">
							<div className="flex items-center justify-between text-sm">
								<span className="flex items-center gap-2 text-muted-foreground">
									<Users className="h-4 w-4" />
									Team Members
								</span>
								<span className="font-medium">
									{memberCount} / {currentPlan.memberLimit}
								</span>
							</div>
							<Progress
								value={(memberCount / currentPlan.memberLimit) * 100}
								className="h-2"
							/>
						</div>
						<div className="space-y-2">
							<div className="flex items-center justify-between text-sm">
								<span className="flex items-center gap-2 text-muted-foreground">
									<FileText className="h-4 w-4" />
									Storage Used
								</span>
								<span className="font-medium">
									{currentPlan.storageUsed} MB / {currentPlan.storageLimit} MB
								</span>
							</div>
							<Progress
								value={
									(currentPlan.storageUsed / currentPlan.storageLimit) * 100
								}
								className="h-2"
							/>
						</div>
					</div>

					{!canManageBilling && (
						<p className="text-muted-foreground text-sm">
							Only team owners can manage billing settings.
						</p>
					)}
				</CardContent>
			</Card>

			{/* Available Plans */}
			{canManageBilling && (
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<Sparkles className="h-5 w-5" />
							Available Plans
						</CardTitle>
						<CardDescription>
							Choose the plan that best fits your team's needs
						</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="grid gap-4 md:grid-cols-3">
							{plans.map((plan) => (
								<div
									key={plan.name}
									className={`rounded-lg border p-4 ${
										plan.current
											? "border-primary bg-primary/5"
											: plan.recommended
												? "border-primary/50"
												: ""
									}`}
								>
									<div className="mb-4 flex items-center justify-between">
										<h3 className="font-semibold">{plan.name}</h3>
										{plan.recommended && (
											<Badge variant="default" className="text-xs">
												Recommended
											</Badge>
										)}
										{plan.current && (
											<Badge variant="outline" className="text-xs">
												Current
											</Badge>
										)}
									</div>
									<div className="mb-4">
										<span className="font-bold text-2xl">${plan.price}</span>
										<span className="text-muted-foreground text-sm">
											/user/month
										</span>
									</div>
									<ul className="mb-4 space-y-2 text-sm">
										{plan.features.map((feature) => (
											<li
												key={feature}
												className="flex items-center gap-2 text-muted-foreground"
											>
												<span className="text-primary">✓</span>
												{feature}
											</li>
										))}
									</ul>
									<Button
										variant={plan.current ? "outline" : "default"}
										className="w-full"
										disabled={plan.current}
									>
										{plan.current ? "Current Plan" : "Upgrade"}
									</Button>
								</div>
							))}
						</div>
						<p className="mt-4 text-center text-muted-foreground text-xs">
							Billing integration coming soon. Contact support for enterprise
							pricing.
						</p>
					</CardContent>
				</Card>
			)}

			{/* Payment Method */}
			{canManageBilling && (
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<CreditCard className="h-5 w-5" />
							Payment Method
						</CardTitle>
						<CardDescription>
							Manage your payment methods for team billing
						</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="flex items-center justify-between rounded-lg border border-dashed p-4">
							<div className="flex items-center gap-4">
								<div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
									<CreditCard className="h-5 w-5 text-muted-foreground" />
								</div>
								<div>
									<p className="font-medium">No payment method</p>
									<p className="text-muted-foreground text-sm">
										Add a payment method to upgrade your plan
									</p>
								</div>
							</div>
							<Button variant="outline" disabled>
								Add Payment Method
							</Button>
						</div>
					</CardContent>
				</Card>
			)}

			{/* Billing History */}
			{canManageBilling && (
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<FileText className="h-5 w-5" />
							Billing History
						</CardTitle>
						<CardDescription>
							View and download your past invoices
						</CardDescription>
					</CardHeader>
					<CardContent>
						{invoices.length === 0 ? (
							<p className="py-4 text-center text-muted-foreground">
								No invoices yet
							</p>
						) : (
							<div className="space-y-2">
								{invoices.map((invoice) => (
									<div
										key={invoice.id}
										className="flex items-center justify-between rounded-lg border p-3"
									>
										<div className="flex items-center gap-4">
											<FileText className="h-4 w-4 text-muted-foreground" />
											<div>
												<p className="font-medium text-sm">{invoice.date}</p>
												<p className="text-muted-foreground text-xs">
													{invoice.id}
												</p>
											</div>
										</div>
										<div className="flex items-center gap-4">
											<span className="font-medium">
												${invoice.amount.toFixed(2)}
											</span>
											<Badge
												variant={
													invoice.status === "paid" ? "default" : "destructive"
												}
											>
												{invoice.status}
											</Badge>
											<Button variant="ghost" size="icon" disabled>
												<Download className="h-4 w-4" />
											</Button>
										</div>
									</div>
								))}
							</div>
						)}
					</CardContent>
				</Card>
			)}

			{/* Billing Support */}
			<Card>
				<CardContent className="pt-6">
					<div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:text-left">
						<div className="flex-1">
							<h3 className="font-medium">Need help with billing?</h3>
							<p className="text-muted-foreground text-sm">
								Contact our support team for questions about your subscription,
								invoices, or enterprise pricing for {teamName}.
							</p>
						</div>
						<Button variant="outline" asChild>
							<a href="mailto:support@bittery.com">
								Contact Support
								<ExternalLink className="ml-2 h-4 w-4" />
							</a>
						</Button>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
