import { createFileRoute } from "@tanstack/react-router";
import { getAllArticles, getCategories } from "@/lib/docs";
import { siteUrl } from "@/lib/urls";

const STATIC_ROUTES = [
	"/",
	"/download",
	"/roadmap",
	"/contact",
	"/docs",
	"/terms",
	"/privacy",
	"/imprint",
];

function buildSitemapXml(): string {
	const paths = [
		...STATIC_ROUTES,
		...getCategories().map((category) => `/docs/${category.slug}`),
		...getAllArticles().map((article) => `/docs/${article.slug}`),
	];

	const urls = paths
		.map((path) => `\t<url>\n\t\t<loc>${siteUrl(path)}</loc>\n\t</url>`)
		.join("\n");

	return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export const Route = createFileRoute("/sitemap.xml")({
	server: {
		handlers: {
			GET: () =>
				new Response(buildSitemapXml(), {
					headers: {
						"Content-Type": "application/xml",
						"Cache-Control": "public, max-age=3600",
					},
				}),
		},
	},
});
