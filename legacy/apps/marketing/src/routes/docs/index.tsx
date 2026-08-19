import { createFileRoute, Link } from "@tanstack/react-router";
import {
	BookOpen,
	CreditCard,
	Rocket,
	ShieldCheck,
	UserCog,
} from "lucide-react";
import { motion } from "motion/react";
import { DocsSidebar, MobileDocsDrawer } from "@/components/docs/docs-sidebar";

import { getAllArticles, getCategories } from "@/lib/docs";
import { seo } from "@/lib/seo";

export const Route = createFileRoute("/docs/")({
	component: DocsIndex,
	head: () => ({
		meta: seo({
			title: "Documentation — Bittery",
			description:
				"Find answers, guides, and resources for getting the most out of Bittery.",
		}),
	}),
});

const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
	Rocket,
	ShieldCheck,
	UserCog,
	CreditCard,
};

function DocsIndex() {
	const categories = getCategories();
	const allArticles = getAllArticles();

	return (
		<>
			<div className="pt-28 pb-20 sm:pt-36 sm:pb-28">
				<div className="mx-auto max-w-5xl px-4">
					<div className="grid gap-10 lg:grid-cols-[256px_1fr]">
						{/* Persistent sidebar */}
						<DocsSidebar currentSlug="" />

						{/* Main content */}
						<div className="min-w-0">
							{/* Hero */}
							<motion.div
								className="text-center lg:text-left"
								initial={{ opacity: 0, y: 16 }}
								animate={{ opacity: 1, y: 0 }}
								transition={{ duration: 0.5, ease: "easeOut" }}
							>
								<div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border/60 bg-accent/40 px-3 py-1 text-muted-foreground text-xs">
									<BookOpen className="size-3.5" />
									Documentation
								</div>
								<h1 className="font-bold font-display text-3xl tracking-tight sm:text-5xl">
									How can we help?
								</h1>
								<p className="mx-auto mt-3 max-w-md text-base text-muted-foreground sm:text-lg lg:mx-0">
									Guides, references, and everything you need to get the most
									out of Bittery.
								</p>
							</motion.div>

							{/* Categories */}
							<motion.div
								className="mt-14 grid gap-4 sm:grid-cols-2"
								initial={{ opacity: 0, y: 16 }}
								animate={{ opacity: 1, y: 0 }}
								transition={{
									duration: 0.5,
									delay: 0.2,
									ease: "easeOut",
								}}
							>
								{categories.map((cat) => {
									const Icon = iconMap[cat.icon] ?? BookOpen;
									return (
										<Link
											key={cat.slug}
											to="/docs/$"
											params={{ _splat: cat.slug }}
											className="group rounded-xl border border-border/60 bg-card/50 p-5 transition-all hover:border-primary/20 hover:bg-card/80 hover:shadow-md"
										>
											<div className="flex items-start gap-4">
												<div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary transition-colors group-hover:bg-primary/12">
													<Icon className="size-5" />
												</div>
												<div className="min-w-0">
													<h3 className="font-semibold text-foreground text-sm">
														{cat.title}
													</h3>
													<p className="mt-1 text-muted-foreground text-xs leading-relaxed">
														{cat.description}
													</p>
													<span className="mt-2 inline-block text-muted-foreground/60 text-xs">
														{cat.articleCount}{" "}
														{cat.articleCount === 1 ? "article" : "articles"}
													</span>
												</div>
											</div>
										</Link>
									);
								})}
							</motion.div>

							{/* Popular articles */}
							<motion.div
								className="mt-16"
								initial={{ opacity: 0, y: 16 }}
								animate={{ opacity: 1, y: 0 }}
								transition={{
									duration: 0.5,
									delay: 0.3,
									ease: "easeOut",
								}}
							>
								<h2 className="mb-5 font-display font-semibold text-foreground text-lg">
									Popular articles
								</h2>
								<div className="grid gap-2 sm:grid-cols-2">
									{allArticles.slice(0, 6).map((article) => (
										<Link
											key={article.slug}
											to="/docs/$"
											params={{ _splat: article.slug }}
											className="group flex items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 transition-all hover:border-border/60 hover:bg-accent/30"
										>
											<div className="size-1.5 shrink-0 rounded-full bg-primary/40 transition-colors group-hover:bg-primary" />
											<div className="min-w-0">
												<p className="truncate font-medium text-foreground text-sm">
													{article.frontmatter.title}
												</p>
												<p className="truncate text-muted-foreground text-xs">
													{article.frontmatter.description}
												</p>
											</div>
										</Link>
									))}
								</div>
							</motion.div>
						</div>
					</div>
				</div>
			</div>

			{/* Mobile drawer */}
			<MobileDocsDrawer currentSlug="" />
		</>
	);
}
