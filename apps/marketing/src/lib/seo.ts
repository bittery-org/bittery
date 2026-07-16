import { siteUrl } from "@/lib/urls";

interface SeoOptions {
	title: string;
	description: string;
	/** Absolute URL or site-relative path. Defaults to the shared og-image. */
	image?: string;
}

/**
 * Builds the title/description/OpenGraph/Twitter meta entries for a route's
 * `head()`. Entries dedupe against the root defaults by `name`/`property`,
 * with the deepest match winning.
 */
export function seo({ title, description, image }: SeoOptions) {
	const imageUrl = image
		? image.startsWith("http")
			? image
			: siteUrl(image)
		: siteUrl("/og-image.png");

	return [
		{ title },
		{ name: "description", content: description },
		{ property: "og:title", content: title },
		{ property: "og:description", content: description },
		{ property: "og:image", content: imageUrl },
		{ name: "twitter:card", content: "summary_large_image" },
		{ name: "twitter:title", content: title },
		{ name: "twitter:description", content: description },
		{ name: "twitter:image", content: imageUrl },
	];
}
