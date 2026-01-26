import {
	Button,
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@bittery/ui";
import { ChevronRight, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface SidebarSectionProps {
	title: string;
	icon?: React.ReactNode;
	children: React.ReactNode;
	defaultOpen?: boolean;
	storageKey?: string;
	onAdd?: () => void;
}

/**
 * Collapsible sidebar section with optional add button.
 * Persists open/closed state in localStorage.
 */
export function SidebarSection({
	title,
	icon,
	children,
	defaultOpen = true,
	storageKey,
	onAdd,
}: SidebarSectionProps) {
	const [isOpen, setIsOpen] = useState(() => {
		if (!storageKey) return defaultOpen;
		const stored = localStorage.getItem(`sidebar-section-${storageKey}`);
		return stored !== null ? stored === "true" : defaultOpen;
	});

	// Persist state to localStorage when it changes
	useEffect(() => {
		if (storageKey) {
			localStorage.setItem(`sidebar-section-${storageKey}`, String(isOpen));
		}
	}, [isOpen, storageKey]);

	const handleOpenChange = useCallback((open: boolean) => {
		setIsOpen(open);
	}, []);

	return (
		<Collapsible open={isOpen} onOpenChange={handleOpenChange}>
			<div className="flex items-center justify-between px-2 py-1">
				<CollapsibleTrigger className="flex flex-1 items-center gap-1 rounded px-1 py-1.5 font-semibold text-muted-foreground text-xs uppercase hover:bg-muted/50">
					<ChevronRight
						className={`size-3 transition-transform ${isOpen ? "rotate-90" : ""}`}
					/>
					{icon && <span className="mr-0.5">{icon}</span>}
					<span className="inline-block max-w-32 truncate">{title}</span>
				</CollapsibleTrigger>
				{onAdd && (
					<Button
						variant="ghost"
						size="sm"
						className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
						onClick={(e) => {
							e.stopPropagation();
							onAdd();
						}}
					>
						<Plus className="size-3" />
					</Button>
				)}
			</div>
			<CollapsibleContent>
				<div className="flex flex-col">{children}</div>
			</CollapsibleContent>
		</Collapsible>
	);
}
