import { createFileRoute } from "@tanstack/react-router";
import { Scale } from "lucide-react";
import { motion } from "motion/react";

export const Route = createFileRoute("/imprint")({
	component: ImprintPage,
	head: () => ({
		meta: [
			{ title: "Imprint — Bittery" },
			{
				name: "description",
				content:
					"Legal notice (Impressum) for Bittery — a zero-knowledge password manager operated by Bittery Software.",
			},
		],
	}),
});

const sections = [
	{
		title: "Information pursuant to § 5 TMG",
		content: `Bittery Software
Julian Sigmund
Hermann-Löns-Straße 12a
78234 Engen
Germany`,
	},
	{
		title: "Contact",
		content: `Email: contact@bittery.com
Website: https://bittery.com`,
	},
	{
		title: "Responsible for content pursuant to § 18 (2) MStV",
		content: `Julian Sigmund
Hermann-Löns-Straße 12a
78234 Engen
Germany`,
	},
	{
		title: "EU dispute resolution",
		content:
			"The European Commission provides a platform for online dispute resolution (ODR): https://ec.europa.eu/consumers/odr/. Our email address can be found above in the imprint.",
	},
	{
		title: "Consumer dispute resolution",
		content:
			"We are not willing or obliged to participate in dispute resolution proceedings before a consumer arbitration board.",
	},
	{
		title: "Liability for content",
		content: `As a service provider, we are responsible for our own content on these pages in accordance with general legislation pursuant to § 7 (1) TMG. However, pursuant to §§ 8 to 10 TMG, we are not obligated to monitor transmitted or stored third-party information or to investigate circumstances that indicate illegal activity.

Obligations to remove or block the use of information under general law remain unaffected. However, liability in this regard is only possible from the point in time at which a concrete infringement of the law becomes known. If we become aware of any such infringements, we will remove the content in question immediately.`,
	},
	{
		title: "Liability for links",
		content: `Our website contains links to external third-party websites over whose content we have no influence. Therefore, we cannot accept any liability for this third-party content. The respective provider or operator of the linked pages is always responsible for the content of those pages. The linked pages were checked for possible legal violations at the time of linking. Illegal content was not recognizable at the time of linking.

However, permanent monitoring of the content of linked pages is unreasonable without concrete evidence of a violation of the law. If we become aware of any infringements, we will remove such links immediately.`,
	},
	{
		title: "Copyright",
		content: `The content and works created by the site operators on these pages are subject to German copyright law. Duplication, processing, distribution, and any form of commercialization of such material beyond the scope of copyright law require the prior written consent of the respective author or creator. Downloads and copies of this site are only permitted for private, non-commercial use.

Insofar as the content on this site was not created by the operator, the copyrights of third parties are respected. In particular, third-party content is identified as such. Should you nevertheless become aware of a copyright infringement, please inform us accordingly. If we become aware of any infringements, we will remove such content immediately.`,
	},
];

function ImprintPage() {
	return (
		<>
			{/* ─── Hero ─────────────────────────────────────────────── */}
			<section className="relative overflow-hidden pt-28 pb-16 sm:pt-36 sm:pb-20">
				<div className="pointer-events-none absolute inset-0 overflow-hidden">
					<div className="absolute top-0 right-0 h-150 w-150 translate-x-1/3 -translate-y-1/3 rounded-full bg-primary/4 blur-3xl" />
					<div className="absolute bottom-0 left-0 h-100 w-100 -translate-x-1/3 translate-y-1/3 rounded-full bg-primary/3 blur-3xl" />
				</div>

				<div className="relative mx-auto max-w-3xl px-4">
					<motion.div
						className="text-center"
						initial={{ opacity: 0, y: 20 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.6, ease: "easeOut" }}
					>
						<div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/8 px-3 py-1 font-medium text-primary text-xs">
							<Scale className="size-3.5" />
							Imprint
						</div>
						<h1 className="font-bold font-display text-3xl tracking-tight sm:text-4xl lg:text-5xl">
							Legal <span className="text-primary">Notice.</span>
						</h1>
						<p className="mx-auto mt-4 max-w-lg text-base text-muted-foreground leading-relaxed sm:text-lg">
							Legal information required under German law (Telemediengesetz).
						</p>
					</motion.div>
				</div>
			</section>

			{/* ─── Content ─────────────────────────────────────────── */}
			<section className="px-4 pt-8 pb-16 sm:pt-12 sm:pb-20">
				<div className="mx-auto max-w-3xl">
					<div className="space-y-8">
						{sections.map((section, i) => (
							<motion.div
								key={section.title}
								className="rounded-2xl border border-border/60 bg-card p-6 sm:p-8"
								initial={{ opacity: 0, y: 12 }}
								whileInView={{ opacity: 1, y: 0 }}
								viewport={{ once: true, margin: "-60px" }}
								transition={{ duration: 0.4, delay: Math.min(i * 0.03, 0.2) }}
							>
								<h2 className="mb-4 font-display font-semibold text-foreground text-lg sm:text-xl">
									{section.title}
								</h2>
								<div className="space-y-3 text-muted-foreground text-sm leading-relaxed sm:text-base">
									{section.content.split("\n\n").map((paragraph) => (
										<p
											key={paragraph.slice(0, 40)}
											className="whitespace-pre-line"
										>
											{paragraph}
										</p>
									))}
								</div>
							</motion.div>
						))}
					</div>
				</div>
			</section>
		</>
	);
}
