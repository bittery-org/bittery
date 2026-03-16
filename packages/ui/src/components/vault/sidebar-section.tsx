import {
	IconChevronRightOutlineDuo18,
	IconPlusOutlineDuo18,
} from "../../icons";
import { cn } from "../../lib/utils";
import { Button } from "../button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "../collapsible";
import { useCallback, useState } from "react";

interface SidebarSectionProps {
	title: string;
	icon?: React.ReactNode;
	children: React.ReactNode;
	defaultOpen?: boolean;
	storageKey?: string;
	onAdd?: () => void;
}

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
		try {
			const stored = localStorage.getItem(`sidebar-section-${storageKey}`);
			return stored !== null ? stored === "true" : defaultOpen;
		} catch {
			return defaultOpen;
		}
	});

	const handleOpenChange = useCallback(
		(open: boolean) => {
			if (storageKey) {
				try {
					localStorage.setItem(`sidebar-section-${storageKey}`, String(open));
				} catch {
					// Ignore storage errors
				}
			}
			setIsOpen(open);
		},
		[storageKey],
	);

	return (
		<Collapsible open={isOpen} onOpenChange={handleOpenChange}>
			<div className="flex items-center justify-between gap-1 px-2 py-1">
				<CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-1.5 font-semibold text-muted-foreground text-xs uppercase hover:bg-muted/50">
					<IconChevronRightOutlineDuo18
						className={cn(
							"size-3",
							"shrink-0",
							"transition-transform",
							isOpen ? "rotate-90" : "",
						)}
					/>
					{icon && <span className="mr-0.5 shrink-0">{icon}</span>}
					<span className="truncate">{title}</span>
				</CollapsibleTrigger>
				{onAdd && (
					<Button
						variant="ghost"
						size="sm"
						className="h-5 w-5 shrink-0 p-0 text-muted-foreground hover:text-foreground"
						onClick={(e) => {
							e.stopPropagation();
							onAdd();
						}}
					>
						<IconPlusOutlineDuo18 className="size-3" />
					</Button>
				)}
			</div>
			<CollapsibleContent>
				<div className="flex flex-col">{children}</div>
			</CollapsibleContent>
		</Collapsible>
	);
}