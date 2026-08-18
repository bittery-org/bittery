/**
 * The iOS switch. Sized to Apple's 51×31 so it reads as the platform control rather than as
 * a web toggle; the knob is white in both themes, exactly as the native one is.
 */

import { cn } from "@bittery/ui/lib/utils";

export function Switch({
	isSelected,
	onSelectedChange,
	disabled,
	ariaLabel,
}: {
	isSelected: boolean;
	onSelectedChange: (next: boolean) => void;
	disabled?: boolean;
	ariaLabel?: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={isSelected}
			aria-label={ariaLabel}
			disabled={disabled}
			onClick={() => onSelectedChange(!isSelected)}
			className={cn(
				"relative inline-flex h-[31px] w-[51px] shrink-0 items-center rounded-full",
				"touch-manipulation outline-none transition-colors duration-200 ease-native",
				"focus-visible:ring-2 focus-visible:ring-ring/60",
				isSelected ? "bg-primary" : "bg-surface-tertiary",
				disabled && "opacity-50",
			)}
		>
			<span
				aria-hidden
				className={cn(
					"size-[27px] rounded-full bg-white shadow-surface transition-transform duration-200 ease-native",
					isSelected ? "translate-x-[22px]" : "translate-x-0.5",
				)}
			/>
		</button>
	);
}
