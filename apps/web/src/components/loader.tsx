import {
	IconLoader2Fill18,
	IconLockOpenOutlineDuo18,
	IconLockOutlineDuo18,
} from "@bittery/ui/icons";
import { useEffect, useRef, useState } from "react";

type RevealPhase = "waiting" | "locked" | "unlocked" | "opening" | "done";

function Doors({
	open,
	children,
}: {
	open: boolean;
	children?: React.ReactNode;
}) {
	return (
		<div
			className="pointer-events-none fixed inset-0 z-9999"
			aria-hidden="true"
		>
			{/* Left door — 1/3 width */}
			<div
				className="absolute inset-y-0 left-0 z-10 w-1/3 overflow-visible bg-secondary md:w-1/4"
				style={{
					transform: open ? "translateX(-110%)" : "translateX(0)",
					transition: open
						? "transform 0.7s cubic-bezier(0.76, 0, 0.24, 1)"
						: "none",
				}}
			>
				<div className="absolute inset-y-0 right-0 w-px bg-black/10 dark:bg-white/10" />

				{/* Icon slot — sits on the right edge, moves with the left door */}
				<div className="absolute top-1/4 right-0 translate-x-1/2">
					{children}
				</div>

				{/* Full Bittery logo — moves with the left door */}
				<div className="absolute top-4 left-4 sm:top-5 sm:left-6">
					<img src="/logo.png" alt="Bittery" className="h-7 w-auto sm:h-10" />
				</div>
			</div>

			{/* Right door — 2/3 width */}
			<div
				className="absolute inset-y-0 right-0 w-2/3 bg-white md:w-3/4 dark:bg-gray-900"
				style={{
					transform: open ? "translateX(100%)" : "translateX(0)",
					transition: open
						? "transform 0.7s cubic-bezier(0.76, 0, 0.24, 1)"
						: "none",
				}}
			>
				<div className="absolute inset-y-0 left-0 w-px bg-black/10 dark:bg-white/10" />
			</div>
		</div>
	);
}

/**
 * Pending loader — used as defaultPendingComponent.
 * Shows closed doors with a spinning loader icon.
 */
export function PendingLoader() {
	return (
		<Doors open={false}>
			<div className="flex items-center justify-center rounded-full border border-border bg-white p-4 shadow-sm dark:bg-gray-900">
				<IconLoader2Fill18 className="size-7 animate-spin text-primary" />
			</div>
		</Doors>
	);
}

/**
 * Reveal loader — rendered in __root.tsx as a fixed overlay.
 * When isLoading transitions from true→false, plays: lock → unlock → doors open.
 */
export function RevealLoader({ isLoading }: { isLoading: boolean }) {
	const [phase, setPhase] = useState<RevealPhase>("waiting");
	const phaseRef = useRef(phase);
	phaseRef.current = phase;
	const hasPlayed = useRef(false);
	const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

	useEffect(() => {
		if (hasPlayed.current) return;

		if (isLoading) {
			setPhase("waiting");
		} else if (phaseRef.current === "waiting") {
			// First load finished — play the unlock sequence once
			hasPlayed.current = true;
			setPhase("locked");
			const t1 = setTimeout(() => setPhase("unlocked"), 400);
			const t2 = setTimeout(() => setPhase("opening"), 700);
			const t3 = setTimeout(() => setPhase("done"), 1500);
			timers.current = [t1, t2, t3];
		}

		return () => {
			for (const t of timers.current) clearTimeout(t);
		};
	}, [isLoading]);

	if (phase === "waiting" || phase === "done") return null;

	return (
		<Doors open={phase === "opening"}>
			<div className="relative flex items-center justify-center rounded-full border border-border bg-white p-4 shadow-sm dark:bg-gray-900">
				<IconLockOutlineDuo18
					className="size-7 text-primary transition-opacity duration-300"
					style={{ opacity: phase === "locked" ? 1 : 0 }}
				/>
				<IconLockOpenOutlineDuo18
					className="absolute size-7 text-primary transition-opacity duration-300"
					style={{
						opacity: phase === "unlocked" || phase === "opening" ? 1 : 0,
					}}
				/>
			</div>
		</Doors>
	);
}
