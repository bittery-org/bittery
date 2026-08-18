/**
 * The pieces the two identity surfaces — full sign-in and quick unlock — share. Ported from
 * `apps/mobile/src/components/auth-kit.tsx`, and local to those two screens on purpose: if a
 * third surface ever needs them they belong in `components/ui/` instead.
 *
 * `apps/mobile/DESIGN-NATIVE.md` is the spec. Nothing here paints purple except the two
 * lockups, which are sanctioned brand moments (§ Brand moments 4).
 */

import { BitteryLogo } from "@bittery/ui";
import { IconEye, IconEyeOff, IconShieldCheck } from "@bittery/ui/icons";
import { cn } from "@bittery/ui/lib/utils";
import { type ComponentType, type ReactNode, useState } from "react";
import {
	iconClass,
	Pressable,
	Switch,
	TextField,
	type TextFieldProps,
} from "@/components/ui";
import { useI18n } from "@/providers/i18n-provider";

/**
 * The lockup that opens the full sign-in screen: the wordmark in brand purple, exactly as
 * the other apps paint it, never a stand-in glyph with "Bittery" typed underneath. This is
 * the one screen whose job is to say *which product* you are signing in to, so it spends
 * the space on the actual logo and nothing else.
 */
export function BrandLockup({
	title,
	subtitle,
}: {
	title: ReactNode;
	subtitle?: ReactNode;
}) {
	return (
		<div className="flex flex-col items-center text-center">
			{/* Not `aria-hidden`: its `<title>` is what names the product to a screen reader. */}
			<BitteryLogo className="h-12 text-primary" />
			<h1 className="mt-6 font-semibold text-foreground text-xl tracking-tight">
				{title}
			</h1>
			{/* No `text-balance`: balancing pinches two lines to half the screen, which reads
			    as a narrow column under a wide title. */}
			{subtitle ? (
				<p className="mt-1.5 max-w-[19rem] text-muted-foreground text-sm">
					{subtitle}
				</p>
			) : null}
		</div>
	);
}

/** The unlock lockup: the same wordmark, smaller, over the greeting. */
export function UnlockLockup({
	title,
	subtitle,
}: {
	title: ReactNode;
	subtitle?: ReactNode;
}) {
	return (
		<div className="flex flex-col items-center text-center">
			<BitteryLogo className="h-10 text-primary" />
			<h1 className="mt-6 font-semibold text-2xl text-foreground tracking-tight">
				{title}
			</h1>
			{subtitle ? (
				<p className="mt-1.5 max-w-[19rem] text-muted-foreground text-sm">
					{subtitle}
				</p>
			) : null}
		</div>
	);
}

/**
 * The held moment before an identity screen knows what to show — the splash redirect, and
 * unlock while it reads the account list.
 *
 * A breathing wordmark rather than a spinner: a spinner says "something is slow", this says
 * "the app is opening". It is decorative, exactly as the bare spinner it replaces was, so it
 * announces nothing.
 */
export function BrandSplash() {
	return (
		<div className="flex min-h-0 flex-1 items-center justify-center">
			<BitteryLogo aria-hidden className="h-12 animate-pulse text-primary" />
		</div>
	);
}

/**
 * The trust line under a sign-in form. Quiet on purpose — it is a reassurance, not a claim
 * competing with the primary action.
 */
export function AuthFooterNote({ label }: { label: ReactNode }) {
	return (
		<p className="flex items-center justify-center gap-1.5 text-muted-foreground text-xs">
			<IconShieldCheck aria-hidden className="size-3.5 shrink-0" />
			{label}
		</p>
	);
}

/**
 * Submit a form from outside it.
 *
 * `BrandButton` is a `Pressable`, which is always `type="button"` — it cannot *be* a form's
 * submit control. `requestSubmit()` takes exactly the path a submit button would: it runs
 * constraint validation (so `required` still bites) and then fires `onSubmit`. A WebView old
 * enough to lack it falls back to a plain dispatch, which skips validation but still signs
 * the user in rather than doing nothing at all.
 */
export function submitForm(form: HTMLFormElement | null) {
	if (!form) return;

	if (typeof form.requestSubmit === "function") {
		form.requestSubmit();
		return;
	}

	form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

/**
 * The identity screens' name for the kit's `TextField`. It is an alias and not a component:
 * the field itself was promoted to `components/ui/text-field.tsx` once attachments and the
 * vault form needed it too, exactly as this module's header says it should be.
 */
export const AuthField = TextField;

interface PasswordFieldProps extends Omit<TextFieldProps, "trailing"> {
	/** Controls the reveal toggle too, so a pending submit cannot be poked at. */
	disabled?: boolean;
}

/** Secret entry with the reveal toggle every identity surface carries. */
export function PasswordField({ disabled, ...props }: PasswordFieldProps) {
	const { m } = useI18n();
	const [isRevealed, setIsRevealed] = useState(false);

	return (
		<AuthField
			{...props}
			disabled={disabled}
			type={isRevealed ? "text" : "password"}
			trailing={
				<Pressable
					onClick={() => setIsRevealed((revealed) => !revealed)}
					disabled={disabled}
					aria-label={
						isRevealed
							? m.vaults_detail_items_form_login_action_hide_password()
							: m.vaults_detail_items_form_login_action_show_password()
					}
					className="absolute right-1.5 flex size-9 items-center justify-center rounded-full text-muted-foreground"
				>
					{isRevealed ? (
						<IconEyeOff className={iconClass.bar} />
					) : (
						<IconEye className={iconClass.bar} />
					)}
				</Pressable>
			}
		/>
	);
}

const NOTICE_TONES = {
	danger: {
		container: "border-danger/20 bg-danger-soft",
		accent: "text-danger",
	},
	warning: {
		container: "border-warning/25 bg-warning-soft",
		accent: "text-warning",
	},
	info: { container: "border-info/25 bg-info-soft", accent: "text-info" },
	/** Advisory rather than status: no colour claim at all. */
	neutral: {
		container: "border-transparent bg-surface-tertiary",
		accent: "text-muted-foreground",
	},
	/** Reserved for the master-password countdown, which is about the vault itself. */
	brand: {
		container: "border-primary/15 bg-primary-soft",
		accent: "text-primary",
	},
} as const;

/** Status block: coloured glyph and title over a soft tint, never a solid fill. */
export function InlineNotice({
	tone,
	icon: Icon,
	title,
	description,
	className,
}: {
	tone: keyof typeof NOTICE_TONES;
	icon: ComponentType<{ className?: string }>;
	title?: ReactNode;
	description: ReactNode;
	className?: string;
}) {
	const styles = NOTICE_TONES[tone];

	return (
		<div
			className={cn(
				"flex items-start gap-3 rounded-xl border px-3.5 py-3",
				styles.container,
				className,
			)}
		>
			<Icon
				aria-hidden
				className={cn("mt-0.5 shrink-0", iconClass.row, styles.accent)}
			/>
			<div className="min-w-0 flex-1">
				{title ? (
					<p className={cn("font-medium text-sm", styles.accent)}>{title}</p>
				) : null}
				<p
					className={cn(
						"text-sm",
						title ? "mt-0.5 text-muted-foreground" : styles.accent,
					)}
				>
					{description}
				</p>
			</div>
		</div>
	);
}

/** The "or" rule between the biometric affordance and the password form. */
export function AuthDivider({ label }: { label: ReactNode }) {
	return (
		<div className="flex items-center gap-3">
			<span aria-hidden className="h-px flex-1 bg-separator" />
			<span className="font-semibold text-2xs text-muted-foreground uppercase tracking-[0.06em]">
				{label}
			</span>
			<span aria-hidden className="h-px flex-1 bg-separator" />
		</div>
	);
}

/**
 * A switch with its own label and description, on a card. The auth screens use it for the
 * two consent choices sign-in offers; settings puts its switches in `ListRow`s instead.
 */
export function AuthToggle({
	label,
	description,
	icon: Icon,
	isSelected,
	onSelectedChange,
	tone = "default",
}: {
	label: ReactNode;
	description?: ReactNode;
	icon?: ComponentType<{ className?: string }>;
	isSelected: boolean;
	onSelectedChange: (next: boolean) => void;
	/** `warning` is for the insecure-transport consent, which must not look routine. */
	tone?: "default" | "warning";
}) {
	return (
		<div
			className={cn(
				"flex items-center gap-3 rounded-2xl border p-3.5",
				tone === "warning"
					? "border-warning/30 bg-warning-soft"
					: "border-border bg-surface shadow-surface",
			)}
		>
			{Icon ? (
				<Icon
					aria-hidden
					className={cn(
						"shrink-0",
						iconClass.bar,
						tone === "warning" ? "text-warning" : "text-muted-foreground",
					)}
				/>
			) : null}
			<div className="min-w-0 flex-1">
				<p className="font-medium text-base text-foreground">{label}</p>
				{description ? (
					<p className="mt-0.5 text-muted-foreground text-sm">{description}</p>
				) : null}
			</div>
			<Switch
				isSelected={isSelected}
				onSelectedChange={onSelectedChange}
				ariaLabel={typeof label === "string" ? label : undefined}
			/>
		</div>
	);
}

/**
 * A quiet, full-width text action — "use a different account", "not you?". Never a second
 * filled button: a screen has exactly one primary action.
 */
export function AuthTextAction({
	label,
	icon: Icon,
	onPress,
}: {
	label: ReactNode;
	icon?: ComponentType<{ className?: string }>;
	onPress: () => void;
}) {
	return (
		<Pressable
			onClick={onPress}
			className="flex h-11 w-full items-center justify-center gap-2 rounded-xl font-medium text-muted-foreground text-sm"
		>
			{Icon ? <Icon aria-hidden className={iconClass.chip} /> : null}
			{label}
		</Pressable>
	);
}
