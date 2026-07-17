import {
	Archive as IconArchive,
	Briefcase as IconBriefcase,
	Check as IconCheck,
	ChevronDown as IconChevronDown,
	ChevronRight as IconChevronRight,
	Clock as IconClock,
	Copy as IconCopy,
	Ellipsis as IconEllipsis,
	Eye as IconEye,
	FileLock as IconFileLock,
	LayoutGrid as IconLayoutGrid,
	Lock as IconLock,
	SquareArrowOutUpRight as IconOpenExternal,
	KeyRound as IconPasskey,
	Pencil as IconPencil,
	Plus as IconPlus,
	Search as IconSearch,
	Share2 as IconShare,
	ArrowDownNarrowWide as IconSortDescending,
	Star as IconStar,
	Trash2 as IconTrash,
	Upload as IconUpload,
	X as IconX,
} from "lucide-react";
import { cn } from "../../../lib/utils";

/**
 * Pixel-faithful recreation of the Bittery desktop app's main vault screen
 * (apps/desktop `/vault/$id` route). Class strings are lifted from the real
 * components — vault-sidebar.tsx, vault-header.tsx, item-list-row.tsx,
 * item-list-controls.tsx, item-detail-page.tsx, field-components.tsx — so
 * the scene stays exact in both themes via the shared tokens.css.
 *
 * The scene is a pure function of `SceneState`; the Remotion composition
 * derives that state from the current frame.
 *
 * NOTE: imports here are relative (no `@/` alias) because this file is also
 * compiled by the Remotion CLI's webpack bundle for the mp4 render.
 */

/* ── Layout constants (must match the classes below; the composition
      derives cursor coordinates from these) ─────────────────────── */
export const SCENE_WIDTH = 1000;
export const SCENE_HEIGHT = 620;
const SIDEBAR_W = 216; // w-54
const LIST_W = 312; // w-78
const HEADER_H = 48; // h-12
const BAR_H = 36; // h-9
const LIST_ROW_STRIDE = 49; // 48px row + 1px gap
const FIRST_ROW_CENTER_Y = HEADER_H + BAR_H + 6 + 24; // p-1.5 + half row
/* Detail content: top bar (36) + py-5 (20) → 104; header 48; +16 →
   field group at 168, rows are min-h-[46px] */
const PASSWORD_ROW_CENTER_Y = 104 + 48 + 16 + 46 * 2 + 23;

export interface SceneState {
	selectedId: string;
	/** 0..1 — entrance progress of the detail pane content */
	detailEnter: number;
	/** 0..1 — visibility of the hover-revealed actions on the password row */
	passwordHover: number;
	/** 0..1 — pressed flash on the password copy button */
	copyPressed: number;
	/** 0..1 — toast visibility (drives its own rise + fade) */
	toast: number;
}

export const INITIAL_STATE: SceneState = {
	selectedId: "github",
	detailEnter: 1,
	passwordHover: 0,
	copyPressed: 0,
	toast: 0,
};

interface LoginItem {
	id: string;
	title: string;
	initials: string;
	gradient: [string, string];
	url: string;
	username: string;
	hasTotp?: boolean;
	hasPasskey?: boolean;
}

const ITEMS: LoginItem[] = [
	{
		id: "github",
		title: "GitHub",
		initials: "GI",
		gradient: ["#6366f1", "#4338ca"],
		url: "https://github.com",
		username: "jordan@arcadia.dev",
		hasTotp: true,
	},
	{
		id: "figma",
		title: "Figma",
		initials: "FI",
		gradient: ["#f43f5e", "#be123c"],
		url: "https://figma.com",
		username: "jordan@arcadia.dev",
		hasPasskey: true,
	},
	{
		id: "linear",
		title: "Linear",
		initials: "LI",
		gradient: ["#8b5cf6", "#6d28d9"],
		url: "https://linear.app",
		username: "jordan@arcadia.dev",
	},
	{
		id: "stripe",
		title: "Stripe",
		initials: "ST",
		gradient: ["#3b82f6", "#1d4ed8"],
		url: "https://stripe.com",
		username: "billing@arcadia.dev",
		hasTotp: true,
	},
	{
		id: "notion",
		title: "Notion",
		initials: "NO",
		gradient: ["#f59e0b", "#b45309"],
		url: "https://notion.so",
		username: "jordan@arcadia.dev",
	},
	{
		id: "vercel",
		title: "Vercel",
		initials: "VE",
		gradient: ["#06b6d4", "#0e7490"],
		url: "https://vercel.com",
		username: "deploys@arcadia.dev",
	},
	{
		id: "slack",
		title: "Slack",
		initials: "SL",
		gradient: ["#ec4899", "#be185d"],
		url: "https://arcadia.slack.com",
		username: "jordan@arcadia.dev",
	},
	{
		id: "tailscale",
		title: "Tailscale",
		initials: "TA",
		gradient: ["#14b8a6", "#0f766e"],
		url: "https://tailscale.com",
		username: "ops@arcadia.dev",
	},
	{
		id: "basecamp",
		title: "Basecamp",
		initials: "BA",
		gradient: ["#84cc16", "#4d7c0f"],
		url: "https://basecamp.com",
		username: "jordan@arcadia.dev",
	},
];

const itemIndex = (id: string) => ITEMS.findIndex((item) => item.id === id);

/* Cursor targets, derived from the layout constants above. */
export const CURSOR = {
	rest: { x: 700, y: 430 },
	/* copy button on the password row: detail content is px-6 inside the
	   right pane, rows px-3, trailing size-7 buttons */
	passwordCopy: { x: 950, y: PASSWORD_ROW_CENTER_Y },
	row: (id: string) => ({
		x: SIDEBAR_W + LIST_W / 2,
		y: FIRST_ROW_CENTER_Y + itemIndex(id) * LIST_ROW_STRIDE,
	}),
};

/* ── Small shared pieces ───────────────────────────────────────── */

function GradientTile({
	gradient,
	className,
	children,
}: {
	gradient: [string, string];
	className?: string;
	children?: React.ReactNode;
}) {
	return (
		<span
			className={cn(
				"flex shrink-0 select-none items-center justify-center font-semibold text-white shadow-[inset_0_0_0_1px_oklch(1_0_0/0.12)]",
				className,
			)}
			style={{
				background: `linear-gradient(135deg, ${gradient[0]}, ${gradient[1]})`,
			}}
		>
			{children}
		</span>
	);
}

function GhostIconButton({ children }: { children: React.ReactNode }) {
	return (
		<span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground">
			{children}
		</span>
	);
}

/* ── Sidebar (vault-sidebar.tsx) ───────────────────────────────── */

const PERSONAL_GRADIENT: [string, string] = ["#ef4444", "#b91c1c"];
const WORK_GRADIENT: [string, string] = ["#f59e0b", "#b45309"];

function SidebarCount({ count }: { count: string }) {
	return (
		<span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
			{count}
		</span>
	);
}

function ActiveIndicator() {
	return (
		<span
			aria-hidden
			className="absolute top-[6px] bottom-[6px] -left-2 w-0.5 rounded-full bg-primary shadow-[0_0_8px_color-mix(in_oklab,var(--color-primary)_80%,transparent)]"
		/>
	);
}

function SectionLabel({ label }: { label: string }) {
	return (
		<div className="flex h-6 items-center gap-1 px-2 pt-3">
			<IconChevronRight className="size-3 rotate-90 text-muted-foreground" />
			<span className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
				{label}
			</span>
		</div>
	);
}

function Sidebar() {
	return (
		<div className="relative flex w-54 shrink-0 flex-col border-r bg-sidebar pt-10">
			<div
				aria-hidden
				className="pointer-events-none absolute inset-x-0 top-0 h-36 bg-[radial-gradient(120%_100%_at_30%_0%,color-mix(in_oklab,var(--color-primary-deep)_8%,transparent),transparent_65%)] dark:bg-[radial-gradient(120%_100%_at_30%_0%,color-mix(in_oklab,var(--color-primary-deep)_14%,transparent),transparent_65%)]"
			/>
			{/* macOS overlay traffic lights (titleBarStyle: Overlay) */}
			<div aria-hidden className="absolute top-[14px] left-5 flex gap-2">
				<i className="size-3 rounded-full bg-[#ff5f57]" />
				<i className="size-3 rounded-full bg-[#febc2e]" />
				<i className="size-3 rounded-full bg-[#28c840]" />
			</div>

			{/* Account switcher */}
			<div className="relative px-2 pt-1.5 pb-0.5">
				<div className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left">
					<span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-linear-to-br from-primary to-primary-deep font-semibold text-[9px] text-primary-foreground shadow-[inset_0_0_0_1px_oklch(1_0_0/0.15)]">
						JD
					</span>
					<span className="truncate font-medium text-sm">Jordan Diaz</span>
					<IconChevronDown className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
				</div>
			</div>

			{/* Nav + vaults + tags */}
			<div className="relative flex flex-1 flex-col overflow-hidden p-2">
				<div className="flex h-7 items-center gap-2 rounded-sm px-2 text-muted-foreground text-sm">
					<IconLayoutGrid className="size-3.5" />
					All Objects
					<SidebarCount count="128" />
				</div>
				<div className="flex h-7 items-center gap-2 rounded-sm px-2 text-muted-foreground text-sm">
					<IconStar className="size-3.5 text-yellow-500" fill="currentColor" />
					Favorites
					<SidebarCount count="12" />
				</div>

				<SectionLabel label="Vaults" />
				<div className="relative mt-0.5 flex h-7 items-center gap-2 rounded-sm bg-selected px-2 font-medium text-foreground text-sm shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-primary)_14%,transparent)]">
					<ActiveIndicator />
					<GradientTile
						gradient={PERSONAL_GRADIENT}
						className="size-5 rounded-[5px]"
					>
						<IconBriefcase className="size-3" />
					</GradientTile>
					<span className="truncate">Personal</span>
					<SidebarCount count="86" />
				</div>
				<div className="mt-0.5 flex h-7 items-center gap-2 rounded-sm px-2 text-muted-foreground text-sm">
					<GradientTile
						gradient={WORK_GRADIENT}
						className="size-5 rounded-[5px]"
					>
						<IconLock className="size-3" />
					</GradientTile>
					<span className="truncate">Work</span>
					<SidebarCount count="42" />
				</div>

				<SectionLabel label="Tags" />
				<div className="mt-0.5 flex h-7 items-center gap-2 rounded-sm px-2 text-muted-foreground text-sm">
					<span className="flex size-3.5 items-center justify-center">
						<i className="size-[7px] rounded-full bg-[#ec4899]" />
					</span>
					dev
				</div>
				<div className="flex h-7 items-center gap-2 rounded-sm px-2 text-muted-foreground text-sm">
					<span className="flex size-3.5 items-center justify-center">
						<i className="size-[7px] rounded-full bg-[#8b5cf6]" />
					</span>
					infra
				</div>

				<div className="mt-auto flex h-7 items-center gap-2 rounded-sm px-2 text-muted-foreground text-sm">
					<IconArchive className="size-3.5" />
					Archive
				</div>
			</div>
		</div>
	);
}

/* ── Header (vault-header.tsx + search-combobox.tsx) ───────────── */

function Header() {
	return (
		<div className="flex h-12 shrink-0 items-center gap-4 border-b px-3">
			<div className="w-full max-w-[360px]">
				<div className="flex h-8 w-full items-center rounded-md border border-input bg-foreground/2 px-2.5 text-sm">
					<IconSearch className="mr-2 size-3.5 shrink-0 text-muted-foreground" />
					<span className="flex-1 text-muted-foreground">
						Search vaults and items...
					</span>
					<kbd className="ml-auto inline-flex h-[18px] select-none items-center gap-0.5 rounded-[4px] border bg-foreground/3 px-1 font-medium font-mono text-[10px] text-muted-foreground tabular-nums">
						<span className="text-[11px]">⌘</span>K
					</kbd>
				</div>
			</div>
			<div className="flex-1" />
			<span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-linear-to-b from-primary to-primary-deep px-3 font-medium text-primary-foreground text-sm shadow-[inset_0_1px_0_oklch(1_0_0/0.22),0_1px_2px_oklch(0_0_0/0.3)] dark:shadow-[inset_0_1px_0_oklch(1_0_0/0.22),0_1px_2px_oklch(0_0_0/0.4),0_0_14px_color-mix(in_oklab,var(--color-primary-deep)_35%,transparent)]">
				<IconPlus className="size-3.5" />
				New Item
			</span>
		</div>
	);
}

/* ── Item list column (item-list-controls.tsx + item-list-row.tsx) ── */

function ItemList({ selectedId }: { selectedId: string }) {
	return (
		<div className="flex w-78 shrink-0 flex-col border-r bg-background">
			<div className="flex h-9 shrink-0 items-center justify-between gap-1 border-b px-2">
				<span className="flex h-7 items-center gap-1.5 rounded-md px-2 font-medium text-muted-foreground text-sm">
					<IconLayoutGrid className="size-3.5" />
					All Categories
					<IconChevronDown className="size-3" />
				</span>
				<span className="flex items-center">
					<GhostIconButton>
						<IconSearch className="size-3.5" />
					</GhostIconButton>
					<GhostIconButton>
						<IconSortDescending className="size-3.5" />
					</GhostIconButton>
				</span>
			</div>
			<div className="flex flex-1 flex-col gap-px overflow-hidden p-1.5">
				{ITEMS.map((item) => {
					const selected = item.id === selectedId;
					return (
						<div
							key={item.id}
							className={cn(
								"relative flex w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 py-2 transition-colors",
								selected &&
									"bg-selected shadow-[inset_0_0_0_1px_oklch(0.70_0.165_288/0.16)]",
							)}
						>
							{selected ? (
								<div className="pointer-events-none absolute top-[7px] bottom-[7px] left-0 z-10 w-[2px] rounded-full bg-primary shadow-[0_0_8px] shadow-primary/50" />
							) : null}
							<GradientTile
								gradient={item.gradient}
								className="size-8 rounded-[7px] text-xs"
							>
								{item.initials}
							</GradientTile>
							<div className="min-w-0 flex-1">
								<span className="flex items-center gap-1.5">
									<span className="truncate font-medium text-foreground text-sm">
										{item.title}
									</span>
									{item.hasTotp ? (
										<IconClock className="size-3 shrink-0 text-muted-foreground" />
									) : null}
									{item.hasPasskey ? (
										<IconPasskey className="size-3 shrink-0 text-muted-foreground" />
									) : null}
								</span>
								<p
									className={cn(
										"mt-0.5 truncate text-xs",
										selected ? "text-foreground/70" : "text-muted-foreground",
									)}
								>
									{item.username}
								</p>
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}

/* ── Detail pane (item-detail-page.tsx + field-components.tsx) ─── */

const ROW_LABEL =
	"truncate font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.05em]";

function DetailRow({
	label,
	value,
	actions,
	actionsVisibility = 0,
	children,
}: {
	label: string;
	value?: React.ReactNode;
	actions?: React.ReactNode;
	actionsVisibility?: number;
	children?: React.ReactNode;
}) {
	return (
		<div className="flex min-h-[46px] items-center gap-2 px-3 py-2">
			<div className="min-w-0 flex-1">
				<p className={ROW_LABEL}>{label}</p>
				{value ? (
					<p className="truncate text-foreground text-sm">{value}</p>
				) : null}
				{children}
			</div>
			{actions ? (
				<div
					className="flex shrink-0 items-center gap-1"
					style={{ opacity: actionsVisibility }}
				>
					{actions}
				</div>
			) : null}
		</div>
	);
}

function TagChip({ color, name }: { color: string; name: string }) {
	return (
		<span className="inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-sm">
			<i className="size-[7px] rounded-full" style={{ background: color }} />
			{name}
			<IconX className="size-3 text-muted-foreground" />
		</span>
	);
}

function GithubExtras() {
	return (
		<>
			<div className="mt-4 overflow-hidden rounded-lg border bg-card">
				<DetailRow label="Notes" value="Rotated after the spring audit." />
			</div>

			<div className="mt-4">
				<p className="font-medium text-sm">Tags</p>
				<div className="mt-2 flex items-center gap-2">
					<TagChip color="#ec4899" name="dev" />
					<TagChip color="#8b5cf6" name="infra" />
					<span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-dashed px-2 text-muted-foreground text-sm">
						<IconPlus className="size-3" />
						Add
					</span>
				</div>
			</div>

			<div className="mt-4">
				<div className="flex items-center justify-between">
					<p className="font-medium text-sm">Attachments (1)</p>
					<span className="inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 font-medium text-sm">
						<IconUpload className="size-3.5 text-muted-foreground" />
						Attach file
					</span>
				</div>
				<div className="mt-2 flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2">
					<IconFileLock className="size-4 shrink-0 text-muted-foreground" />
					<div className="min-w-0 flex-1">
						<p className="truncate text-sm">recovery-codes.txt</p>
						<p className="text-muted-foreground text-xs">2.1 kB</p>
					</div>
					<GhostIconButton>
						<IconChevronDown className="size-4" />
					</GhostIconButton>
					<GhostIconButton>
						<IconPencil className="size-4" />
					</GhostIconButton>
					<span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-destructive">
						<IconTrash className="size-4" />
					</span>
				</div>
			</div>
		</>
	);
}

function DetailPane({ state }: { state: SceneState }) {
	const item = ITEMS.find((i) => i.id === state.selectedId) ?? ITEMS[0];
	const enter = state.detailEnter;
	return (
		<div className="flex min-w-0 flex-1 flex-col">
			{/* Top bar: vault info left, Share / Edit / ··· right */}
			<div className="flex h-9 shrink-0 items-center justify-between border-b px-2.5">
				<span className="flex h-7 items-center gap-2 rounded-md px-1.5">
					<GradientTile
						gradient={PERSONAL_GRADIENT}
						className="size-5 rounded-[5px]"
					>
						<IconBriefcase className="size-3" />
					</GradientTile>
					<span className="font-medium text-sm">Personal</span>
					<IconChevronDown className="size-3 text-muted-foreground" />
				</span>
				<span className="flex items-center gap-0.5">
					<span className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-muted-foreground text-sm">
						<IconShare className="size-3.5" />
						Share
					</span>
					<span className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-muted-foreground text-sm">
						<IconPencil className="size-3.5" />
						Edit
					</span>
					<GhostIconButton>
						<IconEllipsis className="size-4" />
					</GhostIconButton>
				</span>
			</div>

			<div
				className="min-w-0 flex-1 overflow-hidden px-6 py-5"
				style={{
					opacity: enter,
					transform: `translateY(${(1 - enter) * 8}px)`,
				}}
			>
				{/* Detail header with the sanctioned brand glow */}
				<div className="relative flex items-center gap-4">
					<div
						aria-hidden
						className="pointer-events-none absolute -top-8 -left-6 h-28 w-72 bg-[radial-gradient(60%_60%_at_30%_40%,color-mix(in_oklab,var(--color-primary-deep)_6%,transparent),transparent_70%)] dark:bg-[radial-gradient(60%_60%_at_30%_40%,color-mix(in_oklab,var(--color-primary-deep)_9%,transparent),transparent_70%)]"
					/>
					<GradientTile
						gradient={item.gradient}
						className="relative size-12 rounded-lg text-base shadow-[0_2px_8px_oklch(0_0_0/0.3)] dark:shadow-[inset_0_0_0_1px_oklch(1_0_0/0.08),0_2px_8px_oklch(0_0_0/0.25),0_0_24px_color-mix(in_oklab,var(--color-primary-deep)_20%,transparent)]"
					>
						{item.initials}
					</GradientTile>
					<div className="relative min-w-0">
						<h2 className="truncate font-semibold text-lg tracking-tight">
							{item.title}
						</h2>
						<p className="mt-1 truncate text-muted-foreground text-xs">
							{item.url}
						</p>
					</div>
				</div>

				<div className="mt-4 overflow-hidden rounded-lg border bg-card [&>*+*]:border-t">
					<DetailRow
						label="Website"
						value={item.url}
						actionsVisibility={0}
						actions={
							<>
								<GhostIconButton>
									<IconOpenExternal className="size-4" />
								</GhostIconButton>
								<GhostIconButton>
									<IconCopy className="size-4" />
								</GhostIconButton>
							</>
						}
					/>
					<DetailRow
						label="Username"
						value={item.username}
						actionsVisibility={0}
						actions={
							<GhostIconButton>
								<IconCopy className="size-4" />
							</GhostIconButton>
						}
					/>
					<DetailRow
						label="Password"
						actionsVisibility={state.passwordHover}
						actions={
							<>
								<GhostIconButton>
									<IconEye className="size-4" />
								</GhostIconButton>
								<span
									className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground"
									style={{
										backgroundColor: `color-mix(in oklab, var(--color-accent) ${Math.round(state.copyPressed * 100)}%, transparent)`,
									}}
								>
									<IconCopy className="size-4" />
								</span>
							</>
						}
					>
						<p className="truncate font-mono text-muted-foreground text-sm tracking-[0.22em]">
							••••••••••••••••
						</p>
					</DetailRow>
					{item.hasPasskey ? (
						<DetailRow
							label="Passkey"
							value="Created May 12, 2026 · synced to 5 devices"
							actionsVisibility={0}
						/>
					) : null}
				</div>

				{item.id === "github" ? <GithubExtras /> : null}
			</div>
		</div>
	);
}

/* Copied toast — the "aurora pill" from packages/ui sonner.tsx */
function CopiedToast({ visibility }: { visibility: number }) {
	return (
		<div
			className="pointer-events-none absolute bottom-5 left-1/2 flex items-center gap-2 overflow-hidden rounded-full border bg-popover py-2 pr-4 pl-3 shadow-pop"
			style={{
				opacity: visibility,
				transform: `translateX(-50%) translateY(${(1 - visibility) * 10}px)`,
			}}
		>
			<span
				aria-hidden
				className="absolute inset-x-[12%] top-0 h-px bg-linear-to-r from-transparent via-success/60 to-transparent"
			/>
			<span
				aria-hidden
				className="absolute inset-0 bg-[radial-gradient(80%_120%_at_50%_0%,color-mix(in_oklab,var(--color-success)_7%,transparent),transparent_70%)]"
			/>
			<IconCheck className="relative size-3.5 shrink-0 text-success" />
			<span className="relative whitespace-nowrap font-medium text-sm">
				Password copied
			</span>
			<span className="relative whitespace-nowrap text-muted-foreground text-sm">
				· clears in 90s
			</span>
		</div>
	);
}

/* ── The full window ───────────────────────────────────────────── */

export function AppScene({ state }: { state: SceneState }) {
	return (
		<div
			className="relative flex select-none overflow-hidden bg-background text-left font-sans text-foreground antialiased"
			style={{ width: SCENE_WIDTH, height: SCENE_HEIGHT }}
		>
			<Sidebar />
			<div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
				<Header />
				<div className="flex min-w-0 flex-1 overflow-hidden">
					<ItemList selectedId={state.selectedId} />
					<DetailPane state={state} />
				</div>
			</div>
			<CopiedToast visibility={state.toast} />
		</div>
	);
}
