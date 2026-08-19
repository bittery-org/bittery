import { motion } from "motion/react";
import { ArrowLink } from "./cta-button";
import {
	AndroidIcon,
	AppleIcon,
	ChromeIcon,
	EdgeIcon,
	FirefoxIcon,
	LinuxIcon,
	WindowsIcon,
} from "./platform-icons";

const PLATFORMS: {
	label: string;
	icon: React.ComponentType<{ className?: string }>;
	comingSoon?: boolean;
}[] = [
	{ label: "macOS", icon: AppleIcon },
	{ label: "Windows", icon: WindowsIcon },
	{ label: "Linux", icon: LinuxIcon },
	{ label: "iOS", icon: AppleIcon, comingSoon: true },
	{ label: "Android", icon: AndroidIcon, comingSoon: true },
	{ label: "Chrome", icon: ChromeIcon },
	{ label: "Firefox", icon: FirefoxIcon },
	{ label: "Edge", icon: EdgeIcon },
];

export function PlatformsStrip() {
	return (
		<section className="px-4 py-20 sm:py-24">
			<div className="mx-auto max-w-4xl">
				<motion.div
					initial={{ opacity: 0, y: 12 }}
					whileInView={{ opacity: 1, y: 0 }}
					viewport={{ once: true, margin: "-80px" }}
					transition={{ duration: 0.5 }}
					className="flex flex-col items-center text-center"
				>
					<p className="mb-3 font-semibold text-[12px] text-primary uppercase tracking-[0.08em]">
						Everywhere you log in
					</p>
					<h2 className="font-semibold text-[30px] leading-[1.1] tracking-[-0.035em] sm:text-[40px]">
						One vault, every device.
					</h2>
				</motion.div>

				<motion.div
					initial={{ opacity: 0, y: 12 }}
					whileInView={{ opacity: 1, y: 0 }}
					viewport={{ once: true, margin: "-80px" }}
					transition={{ duration: 0.5, delay: 0.1 }}
					className="mt-12 grid grid-cols-4 overflow-hidden rounded-xl border sm:grid-cols-8"
				>
					{PLATFORMS.map((platform, i) => (
						<a
							key={platform.label}
							href="/download"
							className={`group relative flex flex-col items-center gap-2.5 py-6 transition-colors duration-150 hover:bg-foreground/4 ${
								i % 4 !== 0 ? "border-l" : ""
							} ${i >= 4 ? "border-t sm:border-t-0" : ""} ${
								i !== 0 ? "sm:border-l" : ""
							}`}
						>
							<platform.icon
								className={`size-5 transition-colors duration-150 ${
									platform.comingSoon
										? "text-muted-foreground/50"
										: "text-muted-foreground group-hover:text-foreground"
								}`}
							/>
							<span className="font-medium text-[11.5px] text-muted-foreground transition-colors duration-150 group-hover:text-foreground">
								{platform.label}
							</span>
							{platform.comingSoon && (
								<span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 font-mono text-[9px] text-muted-foreground/60 uppercase tracking-[0.08em]">
									soon
								</span>
							)}
						</a>
					))}
				</motion.div>

				<motion.div
					initial={{ opacity: 0 }}
					whileInView={{ opacity: 1 }}
					viewport={{ once: true, margin: "-80px" }}
					transition={{ duration: 0.5, delay: 0.2 }}
					className="mt-8 flex justify-center"
				>
					<ArrowLink href="/download">All downloads</ArrowLink>
				</motion.div>
			</div>
		</section>
	);
}
