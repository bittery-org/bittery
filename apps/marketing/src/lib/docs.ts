import { type CategoryMeta, categories } from "@/content/docs/_categories";

export interface ArticleFrontmatter {
	title: string;
	description: string;
	category: string;
	order?: number;
}

export interface ArticleEntry {
	slug: string;
	category: string;
	frontmatter: ArticleFrontmatter;
	Component: React.ComponentType;
}

// Import all MDX files eagerly at build time.
// Each module exports: default (React component), title, description, category, order
const mdxModules = import.meta.glob<{
	default: React.ComponentType;
	frontmatter: {
		title: string;
		description: string;
		category: string;
		order?: number;
	};
}>("/src/content/docs/**/*.mdx", { eager: true });

function buildArticles(): ArticleEntry[] {
	const entries: ArticleEntry[] = [];

	for (const [path, mod] of Object.entries(mdxModules)) {
		// path looks like /src/content/docs/getting-started/create-account.mdx
		const relative = path.replace("/src/content/docs/", "").replace(".mdx", "");
		// relative is now "getting-started/create-account"
		const parts = relative.split("/");
		const category = parts.slice(0, -1).join("/");
		const fm = mod.frontmatter ?? {};

		entries.push({
			slug: relative,
			category,
			frontmatter: {
				title: fm.title ?? "Untitled",
				description: fm.description ?? "",
				category: fm.category ?? category,
				order: fm.order,
			},
			Component: mod.default,
		});
	}

	return entries.sort((a, b) => {
		// Sort by category order, then by article order
		const catA = categories.find((c) => c.slug === a.category)?.order ?? 999;
		const catB = categories.find((c) => c.slug === b.category)?.order ?? 999;
		if (catA !== catB) return catA - catB;
		return (a.frontmatter.order ?? 999) - (b.frontmatter.order ?? 999);
	});
}

const articles = buildArticles();

export function getAllArticles(): ArticleEntry[] {
	return articles;
}

export function getArticleBySlug(slug: string): ArticleEntry | undefined {
	return articles.find((a) => a.slug === slug);
}

export function getArticlesByCategory(categorySlug: string): ArticleEntry[] {
	return articles.filter((a) => a.category === categorySlug);
}

export function getCategories(): (CategoryMeta & { articleCount: number })[] {
	return categories.map((cat) => ({
		...cat,
		articleCount: articles.filter((a) => a.category === cat.slug).length,
	}));
}

export function searchArticles(query: string): ArticleEntry[] {
	if (!query.trim()) return [];
	const terms = query
		.toLowerCase()
		.split(/\s+/)
		.filter((t) => t.length > 1);
	if (terms.length === 0) return [];

	return articles
		.map((article) => {
			const haystack =
				`${article.frontmatter.title} ${article.frontmatter.description} ${article.frontmatter.category}`.toLowerCase();
			let score = 0;
			for (const term of terms) {
				if (haystack.includes(term)) {
					score += 1;
					// Boost title matches
					if (article.frontmatter.title.toLowerCase().includes(term)) {
						score += 2;
					}
				}
			}
			return { article, score };
		})
		.filter((r) => r.score > 0)
		.sort((a, b) => b.score - a.score)
		.map((r) => r.article);
}
