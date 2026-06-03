import { Eye, GitFork, Github, Server, Star } from "lucide-react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";

export function OpenSourceSection() {
	return (
		<section className="px-4 pt-8 pb-16 sm:pb-28">
			<div className="mx-auto max-w-5xl">
				<motion.div
					className="relative overflow-hidden rounded-2xl border border-border/60 bg-linear-to-br from-card via-card to-primary/3 p-8 sm:rounded-3xl sm:p-12 lg:p-16"
					initial={{ opacity: 0 }}
					whileInView={{ opacity: 1 }}
					viewport={{ once: true, margin: "-100px" }}
					transition={{ duration: 0.5 }}
				>
					<div className="absolute top-0 right-0 h-64 w-64 translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/4 blur-3xl" />

					<div className="relative flex flex-col items-start gap-8 lg:flex-row lg:items-center lg:gap-12">
						<div className="flex-1">
							<div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/8 px-3 py-1 font-medium text-primary text-xs">
								<Github className="size-3.5" />
								Source-available
							</div>
							<h2 className="font-display text-2xl tracking-tight sm:text-3xl lg:text-4xl">
								Trust, but verify
							</h2>
							<p className="mt-3 max-w-lg text-base text-muted-foreground leading-relaxed sm:text-lg">
								Bittery's source code is public under the Functional Source
								License. Audit it, self-host it, or contribute to it. Your
								security shouldn't depend on trust alone.
							</p>

							<p className="mt-4 flex items-center gap-1.5 text-muted-foreground text-sm">
								<Server className="size-3.5 text-primary/60" />
								Also available to self-host for free.
							</p>

							{/* TODO: Enable this */}
							{/* <div className="mt-6 flex items-center gap-6 text-muted-foreground text-sm">
								<div className="flex items-center gap-1.5">
									<Star className="size-4 text-amber-500" />
									<span>2.4k stars</span>
								</div>
								<div className="flex items-center gap-1.5">
									<GitFork className="size-4" />
									<span>180 forks</span>
								</div>
								<div className="flex items-center gap-1.5">
									<Eye className="size-4" />
									<span>48 watchers</span>
								</div>
							</div> */}
						</div>

						<div className="flex shrink-0 flex-col gap-3 sm:flex-row">
							<Button size="lg" className="gap-2 rounded-full px-7">
								<Github className="size-4" />
								View on GitHub
							</Button>
							<Button size="lg" variant="outline" className="rounded-full px-7">
								Read the docs
							</Button>
						</div>
					</div>
				</motion.div>
			</div>
		</section>
	);
}
