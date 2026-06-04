import { MessageSquare, Quote } from "lucide-react";
import { motion } from "motion/react";

// Add real testimonials here once you have them.
// When both arrays are empty the section shows a "coming soon" empty state.
const row1: Testimonial[] = [];
const row2: Testimonial[] = [];

type Testimonial = {
	quote: string;
	name: string;
	role: string;
	avatar: string;
	color: string;
};

function TestimonialCard({ quote, name, role, avatar, color }: Testimonial) {
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
	items: Testimonial[];
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

const PLACEHOLDER_QUOTES = [
	"Your experience with Bittery could be here.",
	"Be the first to share how Bittery helped you.",
	"Early access users share their stories here.",
];

function EmptyState() {
	return (
		<div className="mx-auto max-w-5xl px-4">
			<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
				{PLACEHOLDER_QUOTES.map((text, i) => (
					<div
						key={i}
						className="flex flex-col rounded-2xl border border-dashed border-border bg-card p-6"
					>
						<Quote className="mb-3 size-4 shrink-0 text-primary/40" />
						<p className="flex-1 text-muted-foreground/70 text-sm leading-relaxed italic">
							"{text}"
						</p>
						<div className="mt-4 flex items-center gap-3 border-border/60 border-t pt-4">
							<div className="size-8 animate-pulse rounded-full bg-muted/60 shrink-0" />
							<div className="space-y-1.5">
								<div className="h-2 w-20 animate-pulse rounded-full bg-muted/60" />
								<div className="h-2 w-14 animate-pulse rounded-full bg-muted/50" />
							</div>
						</div>
					</div>
				))}
			</div>
			<div className="mt-8 text-center">
				<div className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/8 px-4 py-2 font-medium text-primary/80 text-sm">
					<MessageSquare className="size-3.5" />
					Reviews from early users will appear here
				</div>
			</div>
		</div>
	);
}

export function Testimonials() {
	const hasTestimonials = row1.length > 0 || row2.length > 0;

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

			{hasTestimonials ? (
				<div className="space-y-4">
					<MarqueeRow items={row1} />
					<MarqueeRow items={row2} reverse />
				</div>
			) : (
				<EmptyState />
			)}
		</section>
	);
}
