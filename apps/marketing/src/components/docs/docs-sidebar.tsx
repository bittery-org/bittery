import {
	BookOpen,
	ChevronDown,
	CreditCard,
	Menu,
	Rocket,
	ShieldCheck,
	UserCog,
	X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { DocsSearch } from "@/components/docs/docs-search";
import { cn } from "@/lib/utils";
import {
	getCategories,
	getArticlesByCategory,
} from "@/lib/docs";

const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
	Rocket,
	ShieldCheck,
	UserCog,
	CreditCard,
};

// ─── Sidebar content (shared between desktop & mobile) ──────────────────────

function SidebarContent({
	currentSlug,
	onNavigate,
}: {
	currentSlug: string;
	onNavigate?: () => void;
}) {
	const categories = getCategories();
	// Determine which category is active (either viewing a category or an article within it)
	const activeCategory =
		categories.find((c) => currentSlug.startsWith(c.slug))?.slug ?? "";

	const [expandedSlugs, setExpandedSlugs] = useState<Set<string>>(() => {
		const initial = new Set<string>();
		if (activeCategory) initial.add(activeCategory);
		return initial;
	});

	// Auto-expand active category when navigating
	useEffect(() => {
		if (activeCategory) {
			setExpandedSlugs((prev) => {
				if (prev.has(activeCategory)) return prev;
				const next = new Set(prev);
				next.add(activeCategory);
				return next;
			});
		}
	}, [activeCategory]);

	const toggleCategory = (slug: string) => {
		setExpandedSlugs((prev) => {
			const next = new Set(prev);
			if (next.has(slug)) {
				next.delete(slug);
			} else {
				next.add(slug);
			}
			return next;
		});
	};

	return (
		<nav className="flex flex-col gap-1">
			{/* Back to docs home */}
			<Link
				to="/docs"
				onClick={onNavigate}
				className={cn(
					"mb-2 flex items-center gap-2.5 rounded-lg px-3 py-2 font-medium text-sm transition-colors",
					currentSlug === ""
						? "bg-primary/8 text-primary"
						: "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
				)}
			>
				<BookOpen className="size-4 shrink-0" />
				All Docs
			</Link>

			<div className="mb-1 h-px bg-border/60" />

			{categories.map((cat) => {
				const Icon = iconMap[cat.icon] ?? BookOpen;
				const isExpanded = expandedSlugs.has(cat.slug);
				const isCategoryActive = currentSlug === cat.slug;
				const articles = getArticlesByCategory(cat.slug);

				return (
					<div key={cat.slug}>
						{/* Category header */}
						<button
							type="button"
							onClick={() => toggleCategory(cat.slug)}
							className={cn(
								"group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors",
								isCategoryActive
									? "bg-primary/8 font-medium text-primary"
									: activeCategory === cat.slug
										? "font-medium text-foreground"
										: "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
							)}
						>
							<Icon className="size-4 shrink-0" />
							<span className="flex-1 truncate">{cat.title}</span>
							<ChevronDown
								className={cn(
									"size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200",
									isExpanded && "rotate-180",
								)}
							/>
						</button>

						{/* Articles within category */}
						<AnimatePresence initial={false}>
							{isExpanded && (
								<motion.div
									initial={{ height: 0, opacity: 0 }}
									animate={{ height: "auto", opacity: 1 }}
									exit={{ height: 0, opacity: 0 }}
									transition={{ duration: 0.2, ease: "easeInOut" }}
									className="overflow-hidden"
								>
									<div className="ml-3.5 border-border/60 border-l py-1 pl-3">
										{articles.map((article) => {
											const isActive = currentSlug === article.slug;
											return (
												<Link
													key={article.slug}
													to="/docs/$"
													params={{ _splat: article.slug }}
													onClick={onNavigate}
													className={cn(
														"block rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
														isActive
															? "bg-primary/8 font-medium text-primary"
															: "text-muted-foreground hover:bg-accent/30 hover:text-foreground",
													)}
												>
													{article.frontmatter.title}
												</Link>
											);
										})}
									</div>
								</motion.div>
							)}
						</AnimatePresence>
					</div>
				);
			})}
		</nav>
	);
}

// ─── Desktop sidebar ────────────────────────────────────────────────────────

export function DocsSidebar({ currentSlug }: { currentSlug: string }) {
	return (
		<motion.aside
			className="hidden lg:block"
			initial={{ opacity: 0, x: -12 }}
			animate={{ opacity: 1, x: 0 }}
			transition={{ duration: 0.4, ease: "easeOut" }}
		>
			<div className="sticky top-28 w-60 overflow-y-auto pr-2" style={{ maxHeight: "calc(100vh - 8rem)" }}>
				<DocsSearch className="mb-3" />
				<SidebarContent currentSlug={currentSlug} />
			</div>
		</motion.aside>
	);
}

// ─── Mobile drawer ──────────────────────────────────────────────────────────

export function MobileDocsDrawer({ currentSlug }: { currentSlug: string }) {
	const [isOpen, setIsOpen] = useState(false);

	// Close on route change
	useEffect(() => {
		setIsOpen(false);
	}, [currentSlug]);

	// Prevent body scroll when open
	useEffect(() => {
		if (isOpen) {
			document.body.style.overflow = "hidden";
		} else {
			document.body.style.overflow = "";
		}
		return () => {
			document.body.style.overflow = "";
		};
	}, [isOpen]);

	return (
		<>
			{/* Floating trigger button */}
			<button
				type="button"
				onClick={() => setIsOpen(true)}
				className="fixed right-5 bottom-5 z-40 flex size-12 items-center justify-center rounded-full border border-border/60 bg-card/95 shadow-lg backdrop-blur-sm transition-all hover:shadow-xl lg:hidden"
				aria-label="Open docs navigation"
			>
				<Menu className="size-5 text-foreground" />
			</button>

			{/* Backdrop + Drawer */}
			<AnimatePresence>
				{isOpen && (
					<>
						<motion.div
							className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm lg:hidden"
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							exit={{ opacity: 0 }}
							transition={{ duration: 0.2 }}
							onClick={() => setIsOpen(false)}
						/>
						<motion.div
							className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-background/95 shadow-xl backdrop-blur-md lg:hidden"
							initial={{ x: "-100%" }}
							animate={{ x: 0 }}
							exit={{ x: "-100%" }}
							transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
						>
							{/* Drawer header */}
							<div className="flex items-center justify-between border-border/60 border-b px-4 py-3">
								<span className="font-display font-semibold text-foreground text-sm">
									Documentation
								</span>
								<button
									type="button"
									onClick={() => setIsOpen(false)}
									className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
									aria-label="Close navigation"
								>
									<X className="size-4" />
								</button>
							</div>

							{/* Drawer content */}
							<div className="flex-1 overflow-y-auto px-3 py-3">
								<DocsSearch className="mb-3" />
								<SidebarContent
									currentSlug={currentSlug}
									onNavigate={() => setIsOpen(false)}
								/>
							</div>
						</motion.div>
					</>
				)}
			</AnimatePresence>
		</>
	);
}
