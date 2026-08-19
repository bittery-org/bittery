import { GITHUB_REPO } from "@bittery/shared/releases";
import { motion } from "motion/react";

const TRUST_MARKERS: { label: string; href?: string }[] = [
	{
		label: "Source-available on GitHub",
		href: `https://github.com/${GITHUB_REPO}`,
	},
	{ label: "One Rust crypto core" },
	{ label: "Zero-knowledge: SRP-6a + AES-256-GCM" },
	{ label: "Self-hostable" },
	{ label: "Every platform" },
];

export function TrustStrip() {
	return (
		<section aria-label="Trust markers" className="border-y">
			<motion.div
				initial={{ opacity: 0 }}
				whileInView={{ opacity: 1 }}
				viewport={{ once: true, margin: "-80px" }}
				transition={{ duration: 0.5 }}
				className="mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-x-8 gap-y-2.5 px-4 py-5"
			>
				{TRUST_MARKERS.map((marker) => (
					<span
						key={marker.label}
						className="inline-flex items-center gap-2 font-mono text-[12px] text-muted-foreground"
					>
						<span
							aria-hidden
							className="size-[5px] rounded-full bg-primary/70"
						/>
						{marker.href ? (
							<a
								href={marker.href}
								target="_blank"
								rel="noopener noreferrer"
								className="transition-colors duration-150 hover:text-foreground"
							>
								{marker.label}
							</a>
						) : (
							marker.label
						)}
					</span>
				))}
			</motion.div>
		</section>
	);
}
