import { MDXProvider } from "@mdx-js/react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
	ArrowLeft,
	ArrowRight,
	BookOpen,
	ChevronRight,
	CreditCard,
	Rocket,
	ShieldCheck,
	UserCog,
} from "lucide-react";
import { motion } from "motion/react";
import { DocsSidebar, MobileDocsDrawer } from "@/components/docs/docs-sidebar";
import { mdxComponents } from "@/components/docs/mdx-components";
import { Layout } from "@/components/layout";
import { getCategoryBySlug } from "@/content/docs/_categories";
import {
	type ArticleEntry,
	getAllArticles,
	getArticleBySlug,
	getArticlesByCategory,
} from "@/lib/docs";

export const Route = createFileRoute("/docs/$")({
	component: DocsSplatPage,
	head: ({ params }) => {
		const splat = params._splat ?? "";
		const article = getArticleBySlug(splat);
		const category = getCategoryBySlug(splat);

		if (article) {
			return {
				meta: [
					{ title: `${article.frontmatter.title} — Bittery Docs` },
					{ name: "description", content: article.frontmatter.description },
				],
			};
		}
		if (category) {
			return {
				meta: [
					{ title: `${category.title} — Bittery Docs` },
					{ name: "description", content: category.description },
				],
			};
		}
		return {
			meta: [{ title: "Not Found — Bittery Docs" }],
		};
	},
});

const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
	Rocket,
	ShieldCheck,
	UserCog,
	CreditCard,
};

function DocsSplatPage() {
	const { _splat: splat = "" } = Route.useParams();

	// Check if this is a category listing
	const category = getCategoryBySlug(splat);
	if (category) {
		return <CategoryPage categorySlug={splat} />;
	}

	// Otherwise it's an article
	const article = getArticleBySlug(splat);
	if (!article) {
		return <NotFoundPage />;
	}

	return <ArticlePage article={article} />;
}

// ─── Category listing ────────────────────────────────────────────────────────

function CategoryPage({ categorySlug }: { categorySlug: string }) {
	const category = getCategoryBySlug(categorySlug);
	const articles = getArticlesByCategory(categorySlug);
	const Icon = iconMap[category?.icon ?? ""] ?? BookOpen;

	return (
		<Layout>
			<div className="pt-28 pb-20 sm:pt-36 sm:pb-28">
				<div className="mx-auto max-w-5xl px-4">
					<div className="grid gap-10 lg:grid-cols-[256px_1fr]">
						{/* Persistent sidebar */}
						<DocsSidebar currentSlug={categorySlug} />

						{/* Main content */}
						<div className="min-w-0">
							{/* Breadcrumb */}
							<motion.nav
								className="mb-6 flex items-center gap-1.5 text-muted-foreground text-xs"
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								transition={{ duration: 0.3 }}
							>
								<Link
									to="/docs"
									className="transition-colors hover:text-foreground"
								>
									Docs
								</Link>
								<ChevronRight className="size-3" />
								<span className="text-foreground">{category?.title}</span>
							</motion.nav>

							{/* Header */}
							<motion.div
								className="mb-8"
								initial={{ opacity: 0, y: 12 }}
								animate={{ opacity: 1, y: 0 }}
								transition={{ duration: 0.4, ease: "easeOut" }}
							>
								<div className="flex items-center gap-3">
									<div className="flex size-10 items-center justify-center rounded-lg bg-primary/8 text-primary">
										<Icon className="size-5" />
									</div>
									<div>
										<h1 className="font-bold font-display text-2xl tracking-tight">
											{category?.title}
										</h1>
										<p className="text-muted-foreground text-sm">
											{category?.description}
										</p>
									</div>
								</div>
							</motion.div>

							{/* Article list */}
							<motion.div
								className="space-y-2"
								initial={{ opacity: 0, y: 12 }}
								animate={{ opacity: 1, y: 0 }}
								transition={{ duration: 0.4, delay: 0.1, ease: "easeOut" }}
							>
								{articles.map((article) => (
									<Link
										key={article.slug}
										to="/docs/$"
										params={{ _splat: article.slug }}
										className="group flex items-center justify-between rounded-xl border border-border/60 bg-card/50 p-4 transition-all hover:border-primary/20 hover:bg-card/80 hover:shadow-sm"
									>
										<div className="min-w-0">
											<p className="font-medium text-foreground text-sm">
												{article.frontmatter.title}
											</p>
											<p className="mt-0.5 truncate text-muted-foreground text-xs">
												{article.frontmatter.description}
											</p>
										</div>
										<ArrowRight className="ml-3 size-4 shrink-0 text-muted-foreground/40 transition-all group-hover:translate-x-0.5 group-hover:text-primary" />
									</Link>
								))}
							</motion.div>
						</div>
					</div>
				</div>
			</div>

			{/* Mobile drawer */}
			<MobileDocsDrawer currentSlug={categorySlug} />
		</Layout>
	);
}

// ─── Article page ────────────────────────────────────────────────────────────

function ArticlePage({ article }: { article: ArticleEntry }) {
	const category = getCategoryBySlug(article.category);
	const allArticles = getAllArticles();
	const currentIndex = allArticles.findIndex((a) => a.slug === article.slug);
	const prevArticle = currentIndex > 0 ? allArticles[currentIndex - 1] : null;
	const nextArticle =
		currentIndex < allArticles.length - 1
			? allArticles[currentIndex + 1]
			: null;

	const { Component } = article;

	return (
		<Layout>
			<div className="pt-28 pb-20 sm:pt-36 sm:pb-28">
				<div className="mx-auto max-w-5xl px-4">
					<div className="grid gap-10 lg:grid-cols-[256px_1fr]">
						{/* Persistent sidebar */}
						<DocsSidebar currentSlug={article.slug} />

						{/* Article content */}
						<motion.div
							className="min-w-0"
							initial={{ opacity: 0, y: 12 }}
							animate={{ opacity: 1, y: 0 }}
							transition={{ duration: 0.4, ease: "easeOut" }}
						>
							{/* Breadcrumb */}
							<nav className="mb-6 flex items-center gap-1.5 text-muted-foreground text-xs">
								<Link
									to="/docs"
									className="transition-colors hover:text-foreground"
								>
									Docs
								</Link>
								<ChevronRight className="size-3" />
								<Link
									to="/docs/$"
									params={{ _splat: article.category }}
									className="transition-colors hover:text-foreground"
								>
									{category?.title}
								</Link>
								<ChevronRight className="size-3" />
								<span className="truncate text-foreground">
									{article.frontmatter.title}
								</span>
							</nav>

							{/* MDX content */}
							<article className="docs-content">
								<MDXProvider components={mdxComponents}>
									<Component />
								</MDXProvider>
							</article>

							{/* Prev / Next navigation */}
							<div className="mt-14 grid gap-3 border-border/60 border-t pt-6 sm:grid-cols-2">
								{prevArticle ? (
									<Link
										to="/docs/$"
										params={{ _splat: prevArticle.slug }}
										className="group flex items-center gap-2 rounded-lg border border-border/60 px-4 py-3 transition-all hover:border-primary/20 hover:bg-card/80"
									>
										<ArrowLeft className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:-translate-x-0.5" />
										<div className="min-w-0">
											<span className="block text-muted-foreground text-xs">
												Previous
											</span>
											<span className="block truncate font-medium text-foreground text-sm">
												{prevArticle.frontmatter.title}
											</span>
										</div>
									</Link>
								) : (
									<div />
								)}
								{nextArticle && (
									<Link
										to="/docs/$"
										params={{ _splat: nextArticle.slug }}
										className="group flex items-center justify-end gap-2 rounded-lg border border-border/60 px-4 py-3 text-right transition-all hover:border-primary/20 hover:bg-card/80"
									>
										<div className="min-w-0">
											<span className="block text-muted-foreground text-xs">
												Next
											</span>
											<span className="block truncate font-medium text-foreground text-sm">
												{nextArticle.frontmatter.title}
											</span>
										</div>
										<ArrowRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
									</Link>
								)}
							</div>
						</motion.div>
					</div>
				</div>
			</div>

			{/* Mobile drawer */}
			<MobileDocsDrawer currentSlug={article.slug} />
		</Layout>
	);
}

// ─── 404 ─────────────────────────────────────────────────────────────────────

function NotFoundPage() {
	return (
		<Layout>
			<div className="flex min-h-[60vh] items-center justify-center pt-24">
				<div className="text-center">
					<h1 className="font-bold font-display text-4xl text-foreground">
						404
					</h1>
					<p className="mt-2 text-muted-foreground">
						This page doesn't exist yet.
					</p>
					<Link
						to="/docs"
						className="mt-4 inline-flex items-center gap-1.5 text-primary text-sm transition-colors hover:text-primary/80"
					>
						<ArrowLeft className="size-3.5" />
						Back to docs
					</Link>
				</div>
			</div>
		</Layout>
	);
}
