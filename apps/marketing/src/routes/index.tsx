import { createFileRoute } from "@tanstack/react-router";
import { FAQSection } from "@/components/landing/faq-section";
import { FeaturesGrid } from "@/components/landing/features-grid";
import { HeroVault } from "@/components/landing/hero-vault";
import { OpenSourceSection } from "@/components/landing/open-source-section";
import { PlatformSection } from "@/components/landing/platform-section";
import { PricingSection } from "@/components/landing/pricing-section";
import { Testimonials } from "@/components/landing/testimonials";

export const Route = createFileRoute("/")({ component: LandingPage });

function LandingPage() {
	return (
		<div className="overflow-hidden">
			<HeroVault />
			<FeaturesGrid />
			<PlatformSection />
			<Testimonials />
			<OpenSourceSection />
			<PricingSection />
			<FAQSection />
		</div>
	);
}
