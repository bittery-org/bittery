import { GITHUB_REPO } from "@bittery/shared/releases";
import { createFileRoute } from "@tanstack/react-router";
import { BentoGrid } from "@/components/landing/bento-grid";
import { FAQSection, faqs } from "@/components/landing/faq-section";
import { FinalCta } from "@/components/landing/final-cta";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { PlatformsStrip } from "@/components/landing/platforms-strip";
import { PricingSection } from "@/components/landing/pricing-section";
import { ReceiptsSection } from "@/components/landing/receipts-section";
import { TrustStrip } from "@/components/landing/trust-strip";
import { WaitlistSection } from "@/components/landing/waitlist-section";
import { seo } from "@/lib/seo";
import { billingMarketingEnabled, siteUrl } from "@/lib/urls";

export const Route = createFileRoute("/")({
	component: LandingPage,
	head: () => ({
		meta: [
			...seo({
				title: "Bittery — Zero-Knowledge Password Manager",
				description:
					"The password manager, redesigned. End-to-end encrypted with a Rust crypto core, source-available, and self-hostable. Import from 1Password, Bitwarden, or LastPass in minutes.",
			}),
			{
				"script:ld+json": {
					"@context": "https://schema.org",
					"@type": "Organization",
					name: "Bittery",
					url: siteUrl(),
					logo: siteUrl("/logo.png"),
					sameAs: [`https://github.com/${GITHUB_REPO}`],
				},
			},
			{
				"script:ld+json": {
					"@context": "https://schema.org",
					"@type": "SoftwareApplication",
					name: "Bittery",
					url: siteUrl(),
					applicationCategory: "SecurityApplication",
					operatingSystem: "macOS, Windows, Linux, Web",
					description:
						"Zero-knowledge password manager with end-to-end encryption, a Rust crypto core, and apps for desktop, web, and browser extensions.",
					...(billingMarketingEnabled()
						? {
								offers: {
									"@type": "Offer",
									price: "0",
									priceCurrency: "USD",
								},
							}
						: {}),
				},
			},
			{
				"script:ld+json": {
					"@context": "https://schema.org",
					"@type": "FAQPage",
					mainEntity: faqs.map((faq) => ({
						"@type": "Question",
						name: faq.question,
						acceptedAnswer: {
							"@type": "Answer",
							text: faq.answer,
						},
					})),
				},
			},
		],
	}),
});

function LandingPage() {
	return (
		<div className="overflow-hidden">
			<Hero />
			<TrustStrip />
			<BentoGrid />
			<ReceiptsSection />
			<HowItWorks />
			<PlatformsStrip />
			{billingMarketingEnabled() ? <PricingSection /> : <WaitlistSection />}
			<FAQSection />
			<FinalCta />
		</div>
	);
}
