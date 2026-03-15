import { IconXmarkOutlineDuo18 } from "../icons";
import { cn } from "../lib/utils";

interface TagBadgeProps {
	name: string;
	onRemove?: () => void;
	onClick?: () => void;
	size?: "sm" | "md";
	className?: string;
}

const TAG_COLORS = [
	"#3b82f6",
	"#10b981",
	"#f59e0b",
	"#ef4444",
	"#8b5cf6",
	"#ec4899",
	"#06b6d4",
	"#f97316",
];

export function getTagColorFromName(name: string): string {
	const hash = name.split("").reduce((acc, char) => {
		return char.charCodeAt(0) + ((acc << 5) - acc);
	}, 0);
	return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length] ?? "#3b82f6";
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
		color,
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
					<IconXmarkOutlineDuo18
						className={cn(size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5")}
					/>
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
