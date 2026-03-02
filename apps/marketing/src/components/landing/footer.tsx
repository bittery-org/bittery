import { BitteryLogo } from "@/components/bittery-logo";
import { Link } from "@tanstack/react-router";

const footerLinks = [
	{
		title: "Product",
		links: [
			{ label: "Features", href: "/", hash: "features" },
			{ label: "Pricing", href: "/", hash: "pricing" },
			{ label: "Download", href: "/" },
			{ label: "Changelog", href: "/" },
		],
	},
	{
		title: "Resources",
		links: [
			{ label: "Documentation", href: "/docs" },
			{ label: "Help Center", href: "/docs" },
			{ label: "Security", href: "/docs/security" },
			{ label: "Status", href: "https://status.bittery.com", external: true },
		],
	},
	{
		title: "Company",
		links: [
			{ label: "About", href: "/about" },
			{ label: "Blog", href: "/" },
			{ label: "GitHub", href: "https://github.com/bittery-org/bittery", external: true },
			{ label: "Contact", href: "/contact" },
		],
	},
	{
		title: "Legal",
		links: [
			{ label: "Privacy", href: "/privacy" },
			{ label: "Terms", href: "/terms" },
			{ label: "License", href: "https://github.com/bittery-org/bittery/blob/main/LICENSE", external: true },
		],
	},
];

export function Footer() {
	return (
		<footer className="border-border/60 border-t bg-muted/20">
			<div className="mx-auto max-w-5xl px-4 py-12 sm:py-16">
				<div className="grid grid-cols-2 gap-8 md:grid-cols-5">
					<div className="col-span-2 md:col-span-1">
						<BitteryLogo className="h-8 text-foreground" />
						<p className="mt-3 max-w-50 text-muted-foreground text-xs leading-relaxed">
							Open-source, zero-knowledge password manager for everyone.
						</p>
					</div>

					{footerLinks.map((group) => (
						<div key={group.title}>
							<h4 className="mb-3 font-semibold text-foreground text-xs">
								{group.title}
							</h4>
							<ul className="space-y-2">
								{group.links.map((link) => (
									<li key={link.label}>
										{"external" in link && link.external ? (
											<a
												href={link.href}
												target="_blank"
												rel="noopener noreferrer"
												className="text-muted-foreground text-xs transition-colors hover:text-foreground"
											>
												{link.label}
											</a>
										) : (
											<Link
												to={link.href}
												className="text-muted-foreground text-xs transition-colors hover:text-foreground"
											>
												{link.label}
											</Link>
										)}
									</li>
								))}
							</ul>
						</div>
					))}
				</div>

				<div className="mt-12 flex flex-col items-center justify-between gap-3 border-border/40 border-t pt-6 sm:flex-row">
					<p className="text-muted-foreground text-xs">
						&copy; {new Date().getFullYear()} Bittery. All rights reserved.
					</p>
					<p className="text-muted-foreground text-xs">
						Made with care for people who care about privacy.
					</p>
				</div>
			</div>
		</footer>
	);
}
