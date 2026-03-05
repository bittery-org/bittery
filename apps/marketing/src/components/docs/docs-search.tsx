import { useNavigate } from "@tanstack/react-router";
import { FileText, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { getArticlesByCategory, getCategories } from "@/lib/docs";
import { cn } from "@/lib/utils";

export function DocsSearch({ className }: { className?: string }) {
	const [open, setOpen] = useState(false);
	const navigate = useNavigate();

	// Keyboard shortcut: Cmd+K / Ctrl+K
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key === "k") {
				e.preventDefault();
				setOpen((prev) => !prev);
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	const handleSelect = useCallback(
		(slug: string) => {
			setOpen(false);
			navigate({ to: "/docs/$", params: { _splat: slug } });
		},
		[navigate],
	);

	const categories = getCategories();

	return (
		<>
			{/* Trigger button */}
			<button
				type="button"
				onClick={() => setOpen(true)}
				className={cn(
					"flex w-full items-center gap-2.5 rounded-lg border border-border/60 bg-accent/30 px-3 py-2 text-muted-foreground text-sm transition-colors hover:border-border hover:bg-accent/50",
					className,
				)}
			>
				<Search className="size-3.5 shrink-0" />
				<span className="flex-1 text-left text-muted-foreground/60">
					Search docs...
				</span>
				<kbd className="pointer-events-none hidden select-none items-center gap-0.5 rounded border border-border/60 bg-background/80 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/60 sm:inline-flex">
					<span className="text-xs">⌘</span>K
				</kbd>
			</button>

			{/* Command palette dialog */}
			<CommandDialog
				open={open}
				onOpenChange={setOpen}
				title="Search documentation"
				description="Search for articles and categories"
				showCloseButton={false}
			>
				<CommandInput placeholder="Search documentation..." />
				<CommandList>
					<CommandEmpty>No results found.</CommandEmpty>
					{categories.map((cat) => {
						const articles = getArticlesByCategory(cat.slug);
						if (articles.length === 0) return null;

						return (
							<CommandGroup key={cat.slug} heading={cat.title}>
								{articles.map((article) => (
									<CommandItem
										key={article.slug}
										value={`${article.frontmatter.title} ${article.frontmatter.description} ${cat.title}`}
										onSelect={() => handleSelect(article.slug)}
										className="cursor-pointer"
									>
										<FileText className="size-4 text-muted-foreground/60" />
										<div className="min-w-0 flex-1">
											<span className="block truncate text-sm">
												{article.frontmatter.title}
											</span>
											<span className="block truncate text-muted-foreground text-xs">
												{article.frontmatter.description}
											</span>
										</div>
									</CommandItem>
								))}
							</CommandGroup>
						);
					})}
				</CommandList>
			</CommandDialog>
		</>
	);
}
