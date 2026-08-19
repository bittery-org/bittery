import { Composition } from "remotion";
import {
	DURATION_IN_FRAMES,
	FPS,
	HeroComposition,
} from "../components/landing/hero-video/composition";
import {
	SCENE_HEIGHT,
	SCENE_WIDTH,
} from "../components/landing/hero-video/scene";
import "../styles.css";

/**
 * Remotion render root for the marketing hero video. The composition is
 * rendered once per theme (tokens.css switches on the `.dark` class) and
 * the results land in `public/videos/` — see the `video:render` script.
 */

function HeroLight() {
	return (
		<div className="h-full w-full bg-background">
			<HeroComposition />
		</div>
	);
}

function HeroDark() {
	return (
		<div className="dark h-full w-full bg-background">
			<HeroComposition />
		</div>
	);
}

export function RemotionRoot() {
	return (
		<>
			<Composition
				id="hero-light"
				component={HeroLight}
				durationInFrames={DURATION_IN_FRAMES}
				fps={FPS}
				width={SCENE_WIDTH}
				height={SCENE_HEIGHT}
			/>
			<Composition
				id="hero-dark"
				component={HeroDark}
				durationInFrames={DURATION_IN_FRAMES}
				fps={FPS}
				width={SCENE_WIDTH}
				height={SCENE_HEIGHT}
			/>
		</>
	);
}
