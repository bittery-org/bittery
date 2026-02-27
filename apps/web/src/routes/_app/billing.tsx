import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
import { Badge, Button, toast } from "@bittery/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { z } from "zod";
import { createRouteGuard } from "@/lib/route-guards";

export const Route = createFileRoute("/_app/billing")({
	beforeLoad: createRouteGuard({
		requiresMode: "cloud",
	}),
	component: BillingRoute,
	validateSearch: z.object({
		checkout: z.string().optional(),
	}),
	head: () => ({
		meta: [{ title: "Billing - Bittery" }],
	}),
});

const paidPlans = ["personal", "family", "team"] as const;

function BillingRoute() {
	const trpc = useTRPC();
	const trpcClient = useTRPCClient();
	const queryClient = useQueryClient();
	const { checkout } = Route.useSearch();

	const billingQuery = useQuery(trpc.billing.status.queryOptions());

	const checkoutMutation = useMutation({
		mutationFn: (plan: (typeof paidPlans)[number]) =>
			trpcClient.billing.createCheckoutSession.mutate({ plan }),
		onSuccess: (result) => {
			if (result.url) {
				window.location.href = result.url;
				return;
			}
			toast.error("Stripe checkout did not return a URL");
		},
		onError: (error: any) => {
			toast.error(error.message || "Failed to start checkout");
		},
	});

	const portalMutation = useMutation({
		mutationFn: () => trpcClient.billing.createPortalSession.mutate(),
		onSuccess: (result) => {
			window.location.href = result.url;
		},
		onError: (error: any) => {
			toast.error(error.message || "Failed to open Stripe billing portal");
		},
	});

	useEffect(() => {
		if (checkout !== "success") return;
		queryClient.invalidateQueries({ queryKey: trpc.billing.status.queryKey() });
		toast.success("Checkout completed. Refreshing billing status...");
	}, [checkout, queryClient, trpc]);

	if (billingQuery.isLoading) {
		return <div className="mx-auto w-full max-w-4xl">Loading billing details...</div>;
	}

	if (billingQuery.error || !billingQuery.data) {
		return (
			<div className="mx-auto w-full max-w-4xl rounded-xl border bg-card p-6">
				<p className="text-sm">Failed to load billing status.</p>
			</div>
		);
	}

	const billing = billingQuery.data;

	return (
		<div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
			<section className="rounded-xl border bg-card p-6">
				<div className="flex items-center justify-between gap-3">
					<div>
						<h1 className="font-semibold text-xl">Billing</h1>
						<p className="mt-1 text-muted-foreground text-sm">
							Manage your cloud plan and subscription.
						</p>
					</div>
					<div className="flex gap-2">
						<Badge variant="secondary">Plan: {billing.plan}</Badge>
						<Badge variant={billing.isActive ? "default" : "outline"}>
							Status: {billing.status}
						</Badge>
					</div>
				</div>

				{billing.requiresPayment && !billing.isActive ? (
					<div className="mt-4 rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-amber-900 text-sm">
						Your selected paid plan requires an active subscription. Complete checkout
						to unlock team and premium actions.
					</div>
				) : null}

				{checkout === "success" ? (
					<div className="mt-4 rounded-lg border border-emerald-300/60 bg-emerald-50 p-3 text-emerald-900 text-sm">
						Checkout completed. Billing status may take a few seconds to update.
					</div>
				) : null}

				{checkout === "cancel" ? (
					<div className="mt-4 rounded-lg border border-muted bg-muted/40 p-3 text-sm">
						Checkout was canceled. You can resume anytime.
					</div>
				) : null}

				<div className="mt-5 flex flex-wrap gap-2">
					{paidPlans.map((plan) => (
						<Button
							key={plan}
							variant={billing.plan === plan ? "default" : "outline"}
							onClick={() => checkoutMutation.mutate(plan)}
							disabled={checkoutMutation.isPending || portalMutation.isPending}
						>
							Choose {plan}
						</Button>
					))}

					{billing.stripeCustomerId ? (
						<Button
							variant="secondary"
							onClick={() => portalMutation.mutate()}
							disabled={checkoutMutation.isPending || portalMutation.isPending}
						>
							Manage Billing
						</Button>
					) : null}
				</div>
			</section>
		</div>
	);
}
