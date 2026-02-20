import { cn } from "@bittery/ui";
import { IconXmarkOutlineDuo18 as X } from "@bittery/ui/icons";

interface TagBadgeProps {
	name: string;
	onRemove?: () => void;
	onClick?: () => void;
	size?: "sm" | "md";
	className?: string;
}

// Default tag colors
const TAG_COLORS = [
	"#3b82f6", // blue
	"#10b981", // green
	"#f59e0b", // amber
	"#ef4444", // red
	"#8b5cf6", // violet
	"#ec4899", // pink
	"#06b6d4", // cyan
	"#f97316", // orange
];

/**
 * Generate a consistent color based on tag name hash
 */
export function getTagColorFromName(name: string): string {
	const hash = name.split("").reduce((acc, char) => {
		return char.charCodeAt(0) + ((acc << 5) - acc);
	}, 0);
	return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

export function TagBadge({
	name,
	onRemove,
	onClick,
	size = "sm",
	className,
}: TagBadgeProps) {
	const color = getTagColorFromName(name);

	const baseClassName = cn(
		"inline-flex items-center gap-1 rounded-full border font-medium transition-colors",
		size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-sm",
		onClick && "cursor-pointer hover:opacity-80",
		className,
	);

	const baseStyle = {
		backgroundColor: `${color}20`,
		borderColor: `${color}40`,
		color: color,
	};

	const content = (
		<>
			{name}
			{onRemove && (
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onRemove();
					}}
					className="ml-0.5 rounded-full hover:bg-black/10"
				>
					<X className={cn(size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5")} />
				</button>
			)}
		</>
	);

	if (onClick) {
		return (
			<button
				type="button"
				className={baseClassName}
				style={baseStyle}
				onClick={onClick}
			>
				{content}
			</button>
		);
	}

	return (
		<span className={baseClassName} style={baseStyle}>
			{content}
		</span>
	);
}
