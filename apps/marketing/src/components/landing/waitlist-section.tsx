import {
	ArrowRight,
	CheckCircle,
	Loader2,
	Server,
	ShieldCheck,
	Sparkles,
} from "lucide-react";
import { motion } from "motion/react";
import type { FormEvent } from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { waitlistUrl } from "@/lib/urls";

type SubmissionState = "idle" | "submitting" | "success" | "error";

export function WaitlistSection() {
	const [email, setEmail] = useState("");
	const [state, setState] = useState<SubmissionState>("idle");

	const submitWaitlist = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (state === "submitting") return;

		setState("submitting");
		try {
			const response = await fetch(waitlistUrl(), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email,
					source: "marketing-landing",
				}),
			});

			if (!response.ok) {
				throw new Error("Waitlist request failed");
			}

			setState("success");
			setEmail("");
		} catch {
			setState("error");
		}
	};

	return (
		<section id="waitlist" className="px-4 py-16 sm:py-24">
			<div className="mx-auto max-w-5xl">
				<motion.div
					className="relative overflow-hidden rounded-2xl border border-border/60 bg-linear-to-br from-card via-card to-primary/3 p-8 sm:rounded-3xl sm:p-12 lg:p-16"
					initial={{ opacity: 0, y: 16 }}
					whileInView={{ opacity: 1, y: 0 }}
					viewport={{ once: true, margin: "-100px" }}
					transition={{ duration: 0.5, ease: "easeOut" }}
				>
					{/* Background glow */}
					<div className="pointer-events-none absolute top-0 left-1/2 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/5 blur-3xl" />
					<div className="pointer-events-none absolute right-0 bottom-0 h-48 w-48 translate-x-1/3 translate-y-1/3 rounded-full bg-primary/4 blur-3xl" />

					<div className="relative flex flex-col items-center text-center">
						<div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/8 px-3 py-1 font-medium text-primary text-xs">
							<Sparkles className="size-3.5" />
							Hosted beta coming soon
						</div>

						<h2 className="max-w-xl font-display text-3xl tracking-tight sm:text-4xl lg:text-5xl">
							Be first in line.
						</h2>
						<p className="mx-auto mt-4 max-w-md text-muted-foreground text-sm leading-relaxed sm:text-base">
							Drop your email and we'll send you an invite as soon as the hosted
							beta opens.
						</p>

						{state === "success" ? (
							<motion.div
								className="mt-8 flex flex-col items-center gap-3"
								initial={{ opacity: 0, scale: 0.95 }}
								animate={{ opacity: 1, scale: 1 }}
								transition={{ duration: 0.3 }}
							>
								<div className="flex size-12 items-center justify-center rounded-full bg-emerald-500/10">
									<CheckCircle className="size-6 text-emerald-500" />
								</div>
								<p className="font-medium text-emerald-600 text-sm dark:text-emerald-400">
									You're on the list!
								</p>
								<p className="text-muted-foreground text-xs">
									We'll email you when your invite is ready.
								</p>
							</motion.div>
						) : (
							<form
								onSubmit={submitWaitlist}
								className="mt-8 flex w-full max-w-md flex-col gap-3 sm:flex-row"
							>
								<label className="min-w-0 flex-1">
									<span className="sr-only">Email</span>
									<input
										type="email"
										required
										value={email}
										onChange={(event) => setEmail(event.target.value)}
										placeholder="you@example.com"
										className="h-12 w-full rounded-full border border-border/80 bg-background px-5 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary"
									/>
								</label>

								<Button
									type="submit"
									className="h-12 shrink-0 gap-2 rounded-full px-6"
									disabled={state === "submitting"}
								>
									{state === "submitting" ? (
										<Loader2 className="size-4 animate-spin" />
									) : (
										<ArrowRight className="size-4" />
									)}
									Join waitlist
								</Button>
							</form>
						)}

						<div className="mt-5 min-h-5">
							{state === "error" && (
								<p className="text-destructive text-sm">
									That didn't go through. Please try again.
								</p>
							)}
							{state !== "success" && state !== "error" && (
								<p className="flex items-center gap-2 text-muted-foreground text-xs">
									<ShieldCheck className="size-3.5 text-primary" />
									We only need your email for the beta queue.
								</p>
							)}
						</div>

						<div className="mt-6 flex items-center gap-1.5 text-muted-foreground text-xs">
							<Server className="size-3.5 text-primary/60" />
							Self-hosting is available right now — no waitlist needed.
						</div>
					</div>
				</motion.div>
			</div>
		</section>
	);
}
