import { Link, useLocation } from "@tanstack/react-router";
import { Menu, Moon, Sun, X } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { BitteryLogo } from "@/components/bittery-logo";
import { Button } from "@/components/ui/button";
import { signupUrl } from "@/lib/urls";
import { cn } from "@/lib/utils";

interface NavLink {
	label: string;
	href: string;
	hash?: string;
	sectionId: string | null;
	isExternal?: boolean;
}

const navLinks: NavLink[] = [
	{ label: "Features", href: "/", hash: "features", sectionId: "features" },
	{ label: "Pricing", href: "/", hash: "pricing", sectionId: "pricing" },
	{ label: "FAQ", href: "/", hash: "faq", sectionId: "faq" },
	{ label: "Docs", href: "/docs", sectionId: null },
	{
		label: "GitHub",
		href: "https://github.com/bittery-org/bittery",
		sectionId: null,
		isExternal: true,
	},
];

const sectionIds = navLinks.map((l) => l.sectionId).filter(Boolean) as string[];

function useActiveSection() {
	const [active, setActive] = useState<string | null>(null);

	useEffect(() => {
		const observers: IntersectionObserver[] = [];
		const visibleSections = new Map<string, number>();

		for (const id of sectionIds) {
			const el = document.getElementById(id);
			if (!el) continue;

			const observer = new IntersectionObserver(
				([entry]) => {
					if (entry.isIntersecting) {
						visibleSections.set(id, entry.intersectionRatio);
					} else {
						visibleSections.delete(id);
					}

					// Only update when a section is visible — otherwise keep the previous one
					if (visibleSections.size === 0) return;

					let best: string | null = null;
					let bestRatio = 0;
					for (const [sId, ratio] of visibleSections) {
						if (ratio > bestRatio) {
							best = sId;
							bestRatio = ratio;
						}
					}
					if (best) setActive(best);
				},
				{
					threshold: [0, 0.2, 0.4, 0.6, 0.8, 1],
					rootMargin: "-80px 0px -20% 0px",
				},
			);
			observer.observe(el);
			observers.push(observer);
		}

		return () => {
			for (const observer of observers) {
				observer.disconnect();
			}
		};
	}, []);

	return active;
}

function ThemeToggle() {
	const [dark, setDark] = useState(() =>
		document.documentElement.classList.contains("dark"),
	);

	const toggle = () => {
		const next = !dark;
		setDark(next);
		document.documentElement.classList.toggle("dark", next);
		localStorage.setItem("theme", next ? "dark" : "light");
	};

	return (
		<button
			type="button"
			onClick={toggle}
			className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
			aria-label="Toggle theme"
		>
			{dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
		</button>
	);
}

export function Header() {
	const [scrolled, setScrolled] = useState(() => window.scrollY > 20);
	const [mobileOpen, setMobileOpen] = useState(false);
	const activeSection = useActiveSection();
	const location = useLocation();

	useEffect(() => {
		const onScroll = () => setScrolled(window.scrollY > 20);
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
	}, []);

	return (
		<header className="fixed top-0 right-0 left-0 z-50 flex justify-center px-4 pt-3">
			<nav
				className={cn(
					"flex w-full max-w-5xl items-center justify-between rounded-2xl border py-2.5 transition-all duration-500",
					scrolled
						? "border-border/60 bg-background/75 px-5 shadow-black/3 shadow-lg backdrop-blur-2xl"
						: "border-transparent bg-transparent px-0",
				)}
			>
				<a
					href="/"
					className="flex shrink-0 items-center gap-2 text-foreground"
				>
					<BitteryLogo className="h-8" />
				</a>

				<div className="hidden items-center gap-1 md:flex">
					{navLinks.map((link) => {
						const isActive =
							link.sectionId != null
								? link.sectionId === activeSection
								: !link.isExternal &&
									link.href !== "/" &&
									location.pathname.startsWith(link.href);
						const linkClassName = cn(
							"relative rounded-lg px-3 py-1.5 text-sm transition-colors",
							isActive
								? "text-foreground"
								: "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
						);
						const content = (
							<>
								{isActive && (
									<motion.span
										layoutId="nav-active-pill"
										className="absolute inset-0 rounded-lg bg-accent/70"
										transition={{
											type: "spring",
											stiffness: 400,
											damping: 25,
											mass: 0.8,
										}}
									/>
								)}
								<span className="relative z-10">{link.label}</span>
							</>
						);

						if (link.isExternal || link.href.startsWith("#")) {
							return (
								<a
									key={link.href}
									href={link.href}
									className={linkClassName}
									{...(link.isExternal
										? { target: "_blank", rel: "noopener noreferrer" }
										: {})}
								>
									{content}
								</a>
							);
						}

						return (
							<Link
								key={link.href + (link.hash ?? "")}
								to={link.href}
								hash={link.hash}
								className={linkClassName}
							>
								{content}
							</Link>
						);
					})}
				</div>

				<div className="flex items-center gap-1.5">
					<ThemeToggle />
					<Button
						size="sm"
						className="rounded-full px-5 font-semibold text-xs"
						asChild
					>
						<a href={signupUrl()}>Get Started</a>
					</Button>
					<button
						type="button"
						className="p-1.5 text-muted-foreground transition-colors hover:text-foreground md:hidden"
						onClick={() => setMobileOpen(!mobileOpen)}
					>
						{mobileOpen ? (
							<X className="size-5" />
						) : (
							<Menu className="size-5" />
						)}
					</button>
				</div>
			</nav>

			{mobileOpen && (
				<div className="fixed inset-x-0 top-16 z-50 px-4 pt-2 md:hidden">
					<div className="space-y-1 rounded-2xl border border-border/60 bg-background/95 p-4 shadow-xl backdrop-blur-2xl">
						{navLinks.map((link) => {
							const isActive =
								link.sectionId != null
									? link.sectionId === activeSection
									: !link.isExternal &&
										link.href !== "/" &&
										location.pathname.startsWith(link.href);
							const mobileLinkClassName = cn(
								"block rounded-lg px-3 py-2.5 text-sm transition-colors",
								isActive
									? "bg-accent/60 text-foreground"
									: "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
							);

							if (link.isExternal || link.href.startsWith("#")) {
								return (
									<a
										key={link.href}
										href={link.href}
										className={mobileLinkClassName}
										onClick={() => setMobileOpen(false)}
										{...(link.isExternal
											? { target: "_blank", rel: "noopener noreferrer" }
											: {})}
									>
										{link.label}
									</a>
								);
							}

							return (
								<Link
									key={link.href + (link.hash ?? "")}
									to={link.href}
									hash={link.hash}
									className={mobileLinkClassName}
									onClick={() => setMobileOpen(false)}
								>
									{link.label}
								</Link>
							);
						})}
					</div>
				</div>
			)}
		</header>
	);
}
