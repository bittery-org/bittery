import { IconLockOpenOutlineDuo18, IconLockOutlineDuo18 } from "@bittery/ui/icons";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

type RevealPhase = "hidden" | "locked" | "unlocked" | "opening";

function Doors({
	open,
	children,
}: {
	open: boolean;
	children?: ReactNode;
}) {
	return (
		<div
			className="pointer-events-none fixed inset-0 z-9999"
			aria-hidden="true"
		>
			<div
				className="absolute inset-y-0 left-0 z-10 w-1/3 overflow-visible bg-secondary"
				style={{
					transform: open ? "translateX(-110%)" : "translateX(0)",
					transition: open
						? "transform 0.7s cubic-bezier(0.76, 0, 0.24, 1)"
						: "none",
				}}
			>
				<div className="absolute inset-y-0 right-0 w-px bg-black/10 dark:bg-white/10" />

				<div className="absolute top-1/4 right-0 translate-x-1/2">
					{children}
				</div>

				<div className="absolute top-8 left-4 sm:top-9 sm:left-6">
					<img src="/logo.png" alt="Bittery" className="h-7 w-auto sm:h-10" />
				</div>
			</div>

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

export function AuthRevealLoader({
	isVisible,
	onComplete,
}: {
	isVisible: boolean;
	onComplete?: () => void;
}) {
	const [phase, setPhase] = useState<RevealPhase>("hidden");
	const onCompleteRef = useRef(onComplete);

	useEffect(() => {
		onCompleteRef.current = onComplete;
	}, [onComplete]);

	useEffect(() => {
		if (!isVisible) {
			setPhase("hidden");
			return;
		}

		setPhase("locked");
		const unlockTimer = setTimeout(() => setPhase("unlocked"), 400);
		const openTimer = setTimeout(() => setPhase("opening"), 700);
		const completeTimer = setTimeout(() => {
			setPhase("hidden");
			onCompleteRef.current?.();
		}, 1500);

		return () => {
			clearTimeout(unlockTimer);
			clearTimeout(openTimer);
			clearTimeout(completeTimer);
		};
	}, [isVisible]);

	if (phase === "hidden") {
		return null;
	}

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
