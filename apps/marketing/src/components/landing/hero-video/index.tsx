import { cn } from "@/lib/utils";

/* Keep in sync with SCENE_WIDTH / SCENE_HEIGHT in ./scene.tsx — imported
   as literals so the scene (and its icon package) stays out of the bundle. */
const SCENE_WIDTH = 1000;
const SCENE_HEIGHT = 620;

/**
 * The hero "screenshot" — a pre-rendered mp4 of the real desktop app UI
 * (see ./composition.tsx + src/remotion). We ship a plain muted <video>
 * instead of a live @remotion/player: muted looping video is the only
 * thing browsers reliably autoplay, and it keeps Remotion out of the
 * client bundle. One render per theme; regenerate with `pnpm video:render`.
 */

const VIDEO_LABEL =
	"The Bittery desktop app copying a password and switching items";

function ThemeVideo({ src, className }: { src: string; className?: string }) {
	return (
		<video
			src={src}
			autoPlay
			muted
			loop
			playsInline
			disablePictureInPicture
			aria-label={VIDEO_LABEL}
			className={cn("block w-full", className)}
		/>
	);
}

export function HeroAppVideo({ className }: { className?: string }) {
	return (
		<div
			className={cn(
				"pointer-events-none mx-auto w-full max-w-4xl select-none overflow-hidden rounded-xl bg-background shadow-[0_0_0_1px_oklch(0_0_0/0.06),0_24px_60px_oklch(0_0_0/0.18)] dark:shadow-[0_0_0_1px_oklch(1_0_0/0.09),0_30px_80px_oklch(0_0_0/0.55),0_0_90px_color-mix(in_oklab,var(--color-primary-deep)_12%,transparent)]",
				className,
			)}
			style={{ aspectRatio: `${SCENE_WIDTH} / ${SCENE_HEIGHT}` }}
		>
			<ThemeVideo src="/videos/hero-light.mp4" className="dark:hidden" />
			<ThemeVideo src="/videos/hero-dark.mp4" className="hidden dark:block" />
		</div>
	);
}
