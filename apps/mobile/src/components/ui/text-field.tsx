/**
 * The app's one text input: a labelled 48px control with an optional leading glyph well and
 * an optional trailing action.
 *
 * It started life as `AuthField` in `components/auth-kit.tsx`, whose header says those pieces
 * move here the moment a third surface needs them. Attachments (display name, rename) and the
 * vault form are that third and fourth surface, so this is the promotion — one definition, so
 * the focus ring and the 48px height cannot drift between identity screens and vault screens.
 *
 * 48px and not 36px: a desktop-height input is a control a thumb misses.
 */

import { cn } from "@bittery/ui/lib/utils";
import {
	type ComponentType,
	type InputHTMLAttributes,
	type ReactNode,
	useId,
} from "react";
import { iconClass } from "./theme";

export interface TextFieldProps
	extends Omit<InputHTMLAttributes<HTMLInputElement>, "className"> {
	label?: ReactNode;
	description?: ReactNode;
	icon?: ComponentType<{ className?: string }>;
	isInvalid?: boolean;
	/** A reveal toggle or any other control pinned inside the field's trailing edge. */
	trailing?: ReactNode;
	inputClassName?: string;
	className?: string;
}

export function TextField({
	label,
	description,
	icon: Icon,
	isInvalid = false,
	trailing,
	inputClassName,
	className,
	id,
	...props
}: TextFieldProps) {
	const generatedId = useId();
	const fieldId = id ?? generatedId;

	return (
		<div className={cn("grid gap-1.5", className)}>
			{label ? (
				<label
					htmlFor={fieldId}
					className="px-1 font-medium text-foreground text-sm"
				>
					{label}
				</label>
			) : null}
			<div className="relative flex items-center">
				{Icon ? (
					<Icon
						aria-hidden
						className={cn(
							"pointer-events-none absolute left-3.5 z-10 text-muted-foreground",
							iconClass.bar,
						)}
					/>
				) : null}
				<input
					{...props}
					id={fieldId}
					aria-invalid={isInvalid || undefined}
					className={cn(
						"h-12 w-full rounded-xl border bg-field px-3.5 text-base text-foreground outline-none",
						"placeholder:text-muted-foreground/70",
						"transition-[border-color,box-shadow] duration-150 ease-native",
						// Focus is the one place a field is allowed purple: ring, never a fill.
						"border-border-strong focus:border-primary focus:ring-[3px] focus:ring-primary/25",
						isInvalid &&
							"border-danger focus:border-danger focus:ring-danger/25",
						"disabled:opacity-60",
						Icon && "pl-11",
						trailing && "pr-12",
						inputClassName,
					)}
				/>
				{trailing}
			</div>
			{description ? (
				<p className="px-1 text-muted-foreground text-xs">{description}</p>
			) : null}
		</div>
	);
}
