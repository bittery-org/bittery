import { Quote } from "lucide-react";
import { motion } from "motion/react";

const row1 = [
	{
		quote:
			"Finally a password manager that doesn't feel like it was designed by engineers for engineers. My whole family uses it now.",
		name: "Sarah Mitchell",
		role: "Product Designer",
		avatar: "SM",
		color: "bg-pink-500",
	},
	{
		quote:
			"I self-host everything, and Bittery made it incredibly easy to set up. Docker compose and done. The sync just works.",
		name: "James Kim",
		role: "Software Engineer",
		avatar: "JK",
		color: "bg-blue-500",
	},
	{
		quote:
			"Set up our whole team in 10 minutes. Shared vaults are a game-changer for credentials we all need access to.",
		name: "Lisa Torres",
		role: "Startup Founder",
		avatar: "LT",
		color: "bg-emerald-500",
	},
	{
		quote:
			"I've reviewed the source code. The cryptographic implementation is solid and follows best practices. Refreshing transparency.",
		name: "Marcus Reed",
		role: "Security Researcher",
		avatar: "MR",
		color: "bg-amber-500",
	},
	{
		quote:
			"Switching from 1Password was seamless. Imported everything in under a minute and the apps feel just as polished.",
		name: "Rachel Chen",
		role: "Product Manager",
		avatar: "RC",
		color: "bg-indigo-500",
	},
];

const row2 = [
	{
		quote:
			"I used to reuse the same password everywhere. Bittery made it painless to fix that — the browser extension fills everything automatically.",
		name: "Emma Walsh",
		role: "Teacher",
		avatar: "EW",
		color: "bg-violet-500",
	},
	{
		quote:
			"The offline mode is perfect for when I'm traveling. Access my passwords on planes, in tunnels, wherever.",
		name: "David Liu",
		role: "Freelance Photographer",
		avatar: "DL",
		color: "bg-teal-500",
	},
	{
		quote:
			"We rolled Bittery out to 200+ employees. The admin controls and SSO integration made it a smooth transition.",
		name: "Tom Anderson",
		role: "IT Director",
		avatar: "TA",
		color: "bg-orange-500",
	},
	{
		quote:
			"Beautiful UI, fast autofill, and I know my data is actually private. What more could you want?",
		name: "Nina Patel",
		role: "UX Designer",
		avatar: "NP",
		color: "bg-rose-500",
	},
	{
		quote:
			"The CLI tool is a game-changer for managing secrets in CI/CD pipelines. Fits perfectly into our dev workflow.",
		name: "Alex Rivera",
		role: "DevOps Engineer",
		avatar: "AR",
		color: "bg-cyan-500",
	},
];

function TestimonialCard({
	quote,
	name,
	role,
	avatar,
	color,
}: {
	quote: string;
	name: string;
	role: string;
	avatar: string;
	color: string;
}) {
	return (
		<div className="flex w-[320px] shrink-0 flex-col rounded-2xl border border-border/60 bg-card p-5 sm:w-[360px]">
			<Quote className="mb-3 size-4 shrink-0 text-primary/25" />
			<p className="flex-1 text-foreground/85 text-sm leading-relaxed">
				"{quote}"
			</p>
			<div className="mt-4 flex items-center gap-3 border-border/40 border-t pt-4">
				<div
					className={`size-8 rounded-full ${color} flex shrink-0 items-center justify-center`}
				>
					<span className="font-bold text-[10px] text-white">{avatar}</span>
				</div>
				<div className="min-w-0">
					<div className="truncate font-semibold text-xs">{name}</div>
					<div className="truncate text-[11px] text-muted-foreground">
						{role}
					</div>
				</div>
			</div>
		</div>
	);
}

function MarqueeRow({
	items,
	reverse = false,
}: {
	items: typeof row1;
	reverse?: boolean;
}) {
	const doubled = [...items, ...items];

	return (
		<div className="group overflow-hidden">
			<div
				className={`flex w-max gap-4 ${reverse ? "animate-marquee-reverse" : "animate-marquee"} group-hover:[animation-play-state:paused]`}
				style={{ ["--marquee-duration" as string]: "35s" }}
			>
				{doubled.map((t, i) => (
					<TestimonialCard key={`${t.name}-${i}`} {...t} />
				))}
			</div>
		</div>
	);
}

export function Testimonials() {
	return (
		<section className="overflow-hidden py-20 sm:py-28">
			<motion.div
				className="mx-auto mb-10 max-w-5xl px-4 text-center sm:mb-14"
				initial={{ opacity: 0 }}
				whileInView={{ opacity: 1 }}
				viewport={{ once: true, margin: "-100px" }}
				transition={{ duration: 0.5 }}
			>
				<h2 className="font-display text-3xl tracking-tight sm:text-4xl md:text-5xl">
					Loved by real people
				</h2>
				<p className="mx-auto mt-3 max-w-lg text-base text-muted-foreground sm:text-lg">
					From families to engineering teams, people trust Bittery with what
					matters most.
				</p>
			</motion.div>

			<div className="space-y-4">
				<MarqueeRow items={row1} />
				<MarqueeRow items={row2} reverse />
			</div>
		</section>
	);
}
