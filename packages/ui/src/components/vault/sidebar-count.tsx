import { cn } from "../../lib/utils";

interface SidebarCountProps {
	/** Renders nothing when undefined, so loading never flashes a zero. */
	count?: number;
	className?: string;
}

export function SidebarCount({ count, className }: SidebarCountProps) {
	if (count === undefined) return null;

	return (
		<span
			className={cn(
				"ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums",
				className,
			)}
		>
			{count}
		</span>
	);
}
