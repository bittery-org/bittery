import { AlertOctagon, AlertTriangle, Info, Lightbulb } from "lucide-react";
import type React from "react";
import { cn } from "@/lib/utils";

function H1({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
	return (
		<h1
			className={cn(
				"mt-2 scroll-m-20 font-bold font-display text-2xl text-foreground tracking-tight sm:text-3xl",
				className,
			)}
			{...props}
		/>
	);
}

function H2({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
	return (
		<h2
			className={cn(
				"mt-10 scroll-m-20 border-border/60 border-b pb-2 font-display font-semibold text-foreground text-xl tracking-tight first:mt-0",
				className,
			)}
			{...props}
		/>
	);
}

function H3({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
	return (
		<h3
			className={cn(
				"mt-8 scroll-m-20 font-semibold text-foreground text-lg tracking-tight",
				className,
			)}
			{...props}
		/>
	);
}

function H4({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
	return (
		<h4
			className={cn(
				"mt-6 scroll-m-20 font-semibold text-base text-foreground tracking-tight",
				className,
			)}
			{...props}
		/>
	);
}

function P({
	className,
	...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
	return (
		<p
			className={cn(
				"not-first:mt-4 text-muted-foreground leading-7",
				className,
			)}
			{...props}
		/>
	);
}

function A({
	className,
	...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
	return (
		<a
			className={cn(
				"font-medium text-primary underline decoration-primary/30 underline-offset-4 transition-colors hover:decoration-primary/60",
				className,
			)}
			{...props}
		/>
	);
}

function Blockquote({
	className,
	...props
}: React.BlockquoteHTMLAttributes<HTMLQuoteElement>) {
	return (
		<blockquote
			className={cn(
				"mt-4 border-primary/40 border-l-2 pl-4 text-muted-foreground italic",
				className,
			)}
			{...props}
		/>
	);
}

function Ul({ className, ...props }: React.HTMLAttributes<HTMLUListElement>) {
	return (
		<ul
			className={cn(
				"my-4 ml-6 list-disc text-muted-foreground [&>li]:mt-2",
				className,
			)}
			{...props}
		/>
	);
}

function Ol({ className, ...props }: React.OlHTMLAttributes<HTMLOListElement>) {
	return (
		<ol
			className={cn(
				"my-4 ml-6 list-decimal text-muted-foreground [&>li]:mt-2",
				className,
			)}
			{...props}
		/>
	);
}

function Code({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
	return (
		<code
			className={cn(
				"relative rounded bg-accent/60 px-[0.3rem] py-[0.15rem] font-mono text-foreground text-sm",
				className,
			)}
			{...props}
		/>
	);
}

function Pre({ className, ...props }: React.HTMLAttributes<HTMLPreElement>) {
	return (
		<pre
			className={cn(
				"mt-4 overflow-x-auto rounded-lg border border-border/60 bg-accent/30 p-4",
				className,
			)}
			{...props}
		/>
	);
}

function Table({
	className,
	...props
}: React.TableHTMLAttributes<HTMLTableElement>) {
	return (
		<div className="my-6 w-full overflow-auto rounded-lg border border-border/60">
			<table className={cn("w-full text-sm", className)} {...props} />
		</div>
	);
}

function Thead({
	className,
	...props
}: React.HTMLAttributes<HTMLTableSectionElement>) {
	return <thead className={cn("bg-accent/40", className)} {...props} />;
}

function Tbody({
	className,
	...props
}: React.HTMLAttributes<HTMLTableSectionElement>) {
	return (
		<tbody
			className={cn("[&>tr:last-child]:border-b-0", className)}
			{...props}
		/>
	);
}

function Tr({
	className,
	...props
}: React.HTMLAttributes<HTMLTableRowElement>) {
	return (
		<tr
			className={cn(
				"border-border/60 border-b transition-colors hover:bg-accent/20",
				className,
			)}
			{...props}
		/>
	);
}

function Th({
	className,
	...props
}: React.ThHTMLAttributes<HTMLTableCellElement>) {
	return (
		<th
			className={cn(
				"px-4 py-2.5 text-left font-semibold text-foreground text-xs uppercase tracking-wider",
				className,
			)}
			{...props}
		/>
	);
}

function Td({
	className,
	...props
}: React.TdHTMLAttributes<HTMLTableCellElement>) {
	return (
		<td
			className={cn("px-4 py-2.5 text-muted-foreground", className)}
			{...props}
		/>
	);
}

function Hr({ className, ...props }: React.HTMLAttributes<HTMLHRElement>) {
	return <hr className={cn("my-6 border-border/60", className)} {...props} />;
}

function Img({
	className,
	alt,
	...props
}: React.ImgHTMLAttributes<HTMLImageElement>) {
	return (
		<img
			className={cn("my-4 rounded-lg border border-border/40", className)}
			alt={alt}
			{...props}
		/>
	);
}

// Custom components available in MDX

const calloutConfig = {
	info: {
		icon: Info,
		container: "border-primary/20 bg-primary/5",
		iconStyle: "text-primary bg-primary/10",
		title: "Note",
		titleColor: "text-primary",
	},
	warning: {
		icon: AlertTriangle,
		container: "border-amber-500/20 bg-amber-500/5",
		iconStyle: "text-amber-600 dark:text-amber-400 bg-amber-500/10",
		title: "Warning",
		titleColor: "text-amber-700 dark:text-amber-400",
	},
	tip: {
		icon: Lightbulb,
		container: "border-emerald-500/20 bg-emerald-500/5",
		iconStyle: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10",
		title: "Tip",
		titleColor: "text-emerald-700 dark:text-emerald-400",
	},
	danger: {
		icon: AlertOctagon,
		container: "border-red-500/20 bg-red-500/5",
		iconStyle: "text-red-600 dark:text-red-400 bg-red-500/10",
		title: "Danger",
		titleColor: "text-red-700 dark:text-red-400",
	},
} as const;

export function Callout({
	children,
	type = "info",
}: {
	children: React.ReactNode;
	type?: "info" | "warning" | "tip" | "danger";
}) {
	const config = calloutConfig[type];
	const Icon = config.icon;

	return (
		<div
			className={cn("my-4 flex gap-3 rounded-lg border p-4", config.container)}
		>
			<div
				className={cn(
					"flex size-6 shrink-0 items-center justify-center rounded-md",
					config.iconStyle,
				)}
			>
				<Icon className="size-3.5" />
			</div>
			<div className="min-w-0 text-sm leading-relaxed [&>p]:mt-0">
				<p className={cn("mb-1 font-semibold text-xs", config.titleColor)}>
					{config.title}
				</p>
				<div className="text-muted-foreground [&>p]:text-muted-foreground">
					{children}
				</div>
			</div>
		</div>
	);
}

export function Steps({ children }: { children: React.ReactNode }) {
	return (
		<div className="docs-steps mt-6 ml-4 border-border/40 border-l-2 pl-6 [counter-reset:step]">
			{children}
		</div>
	);
}

export function Step({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<div className="docs-step relative pb-8 [counter-increment:step] last:pb-0">
			<div className="absolute top-0 -left-[calc(1.5rem+12px)] flex size-5.5 items-center justify-center rounded-full bg-primary font-bold font-mono text-[11px] text-primary-foreground leading-none before:content-[counter(step)]" />
			<h4 className="-mt-0.5 font-semibold text-foreground text-sm">{title}</h4>
			<div className="mt-1.5 text-muted-foreground text-sm leading-relaxed [&>p]:mt-1">
				{children}
			</div>
		</div>
	);
}

/** Maps HTML elements to styled components for MDX rendering */
export const mdxComponents = {
	h1: H1,
	h2: H2,
	h3: H3,
	h4: H4,
	p: P,
	a: A,
	blockquote: Blockquote,
	ul: Ul,
	ol: Ol,
	code: Code,
	pre: Pre,
	table: Table,
	thead: Thead,
	tbody: Tbody,
	tr: Tr,
	th: Th,
	td: Td,
	hr: Hr,
	img: Img,
	// Custom components
	Callout,
	Steps,
	Step,
};
