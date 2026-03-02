import {
	Code2,
	KeyRound,
	MonitorSmartphone,
	Share2,
	ShieldCheck,
	WifiOff,
} from "lucide-react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

const features = [
	{
		icon: ShieldCheck,
		title: "Your data, encrypted",
		description:
			"Everything is encrypted on your device before it's sent anywhere. We can't read your passwords even if we wanted to.",
		span: "md:col-span-2",
		iconBg: "bg-primary/10 text-primary",
	},
	{
		icon: KeyRound,
		title: "Two-key protection",
		description:
			"Your password plus a unique Secret Key. Even if someone guesses your password, they still can't get in.",
		span: "md:col-span-1",
		iconBg: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
	},
	{
		icon: Code2,
		title: "Open source",
		description:
			"Our code is public. Anyone can verify we do what we say. Or host it yourself — it's your call.",
		span: "md:col-span-1",
		iconBg: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
	},
	{
		icon: MonitorSmartphone,
		title: "Everywhere you are",
		description:
			"Web, desktop, browser extension, and mobile. Your passwords sync seamlessly across all your devices.",
		span: "md:col-span-2",
		iconBg: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
	},
	{
		icon: Share2,
		title: "Share safely",
		description:
			"Share passwords with family or team members using encrypted vaults. Or send a secure link that expires.",
		span: "md:col-span-2",
		iconBg: "bg-pink-500/10 text-pink-600 dark:text-pink-400",
	},
	{
		icon: WifiOff,
		title: "Works offline",
		description:
			"Access your passwords even without internet. Everything syncs when you're back online.",
		span: "md:col-span-1",
		iconBg: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
	},
];

export function FeaturesGrid() {
	return (
		<section id="features" className="px-4 py-20 sm:py-28">
			<div className="mx-auto max-w-5xl">
				<motion.div
					className="mb-12 text-center sm:mb-16"
					initial={{ opacity: 0 }}
					whileInView={{ opacity: 1 }}
					viewport={{ once: true, margin: "-100px" }}
					transition={{ duration: 0.5 }}
				>
					<h2 className="font-display text-3xl tracking-tight sm:text-4xl md:text-5xl">
						Security that just works
					</h2>
					<p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground sm:text-lg">
						Built with the same encryption used by banks and governments —
						without making you think about it.
					</p>
				</motion.div>

				<div className="grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-3">
					{features.map((feature, i) => (
						<motion.div
							key={feature.title}
							className={cn(
								"group relative rounded-2xl border border-border/60 bg-card p-5 transition-all duration-300 hover:border-border hover:shadow-black/[0.03] hover:shadow-lg sm:p-6",
								feature.span,
							)}
							initial={{ opacity: 0, y: 12 }}
							whileInView={{ opacity: 1, y: 0 }}
							viewport={{ once: true, margin: "-80px" }}
							transition={{
								duration: 0.4,
								delay: i * 0.05,
							}}
						>
							<div
								className={cn(
									"mb-4 flex size-10 items-center justify-center rounded-xl",
									feature.iconBg,
								)}
							>
								<feature.icon className="size-5" />
							</div>
							<h3 className="mb-1.5 font-semibold text-base">
								{feature.title}
							</h3>
							<p className="text-muted-foreground text-sm leading-relaxed">
								{feature.description}
							</p>
						</motion.div>
					))}
				</div>
			</div>
		</section>
	);
}
