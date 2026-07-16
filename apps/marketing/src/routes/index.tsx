import { createFileRoute } from "@tanstack/react-router";
import { BentoGrid } from "@/components/landing/bento-grid";
import { FAQSection } from "@/components/landing/faq-section";
import { FinalCta } from "@/components/landing/final-cta";
import { Hero } from "@/components/landing/hero";
import { PricingSection } from "@/components/landing/pricing-section";
import { ReceiptsSection } from "@/components/landing/receipts-section";
import { WaitlistSection } from "@/components/landing/waitlist-section";
import { billingMarketingEnabled } from "@/lib/urls";

export const Route = createFileRoute("/")({ component: LandingPage });

function LandingPage() {
	return (
		<div className="overflow-hidden">
			<Hero />
			<BentoGrid />
			<ReceiptsSection />
			{billingMarketingEnabled() ? <PricingSection /> : <WaitlistSection />}
			<FAQSection />
			<FinalCta />
		</div>
	);
}
