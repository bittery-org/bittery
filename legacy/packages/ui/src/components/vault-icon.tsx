import { cn } from "../lib/utils";

export type VaultIconState = "locked" | "unlocking" | "unlocked";

interface VaultIconProps {
	state?: VaultIconState;
	className?: string;
	size?: number;
}

export function VaultIcon({
	state = "locked",
	className,
	size = 160,
}: VaultIconProps) {
	return (
		<div
			className={cn("relative shrink-0", className)}
			style={{
				width: size,
				height: size,
			}}
		>
			<svg
				width={size}
				height={size}
				viewBox="0 0 160 160"
				fill="none"
				xmlns="http://www.w3.org/2000/svg"
				className="drop-shadow-lg"
				preserveAspectRatio="xMidYMid meet"
			>
				<title>Vault {state}</title>
				{/* Outer vault circle - background */}
				<circle
					cx="80"
					cy="80"
					r="75"
					fill="url(#vaultGradient)"
					className="transition-all duration-700"
				/>

				{/* Vault door segments - rotate when unlocking */}
				<g
					className={cn(
						"transition-transform duration-700 ease-in-out",
						state === "unlocking" && "animate-spin",
						state === "unlocked" && "rotate-180",
					)}
					style={{ transformOrigin: "80px 80px" }}
				>
					{/* Outer ring segments */}
					{[0, 60, 120, 180, 240, 300].map((rotation) => (
						<rect
							key={rotation}
							x="74"
							y="15"
							width="12"
							height="30"
							rx="2"
							fill="#1e3a8a"
							opacity="0.3"
							transform={`rotate(${rotation} 80 80)`}
						/>
					))}
				</g>

				{/* Inner vault door - opens */}
				<g
					className={cn(
						"transition-all duration-500",
						state === "unlocked" && "scale-90 opacity-0",
					)}
					style={{ transformOrigin: "80px 80px" }}
				>
					{/* Main door circle */}
					<circle cx="80" cy="80" r="50" fill="#2563eb" />
					<circle cx="80" cy="80" r="50" fill="url(#doorShine)" opacity="0.3" />

					{/* Door detail rings */}
					<circle
						cx="80"
						cy="80"
						r="45"
						fill="none"
						stroke="#1e40af"
						strokeWidth="2"
						opacity="0.5"
					/>
					<circle
						cx="80"
						cy="80"
						r="35"
						fill="none"
						stroke="#1e40af"
						strokeWidth="1.5"
						opacity="0.3"
					/>

					{/* Center lock mechanism */}
					<g
						className={cn(
							"transition-transform duration-500",
							state === "unlocking" && "rotate-90",
							state === "unlocked" && "rotate-180 scale-75",
						)}
						style={{ transformOrigin: "80px 80px" }}
					>
						{/* Lock handle */}
						<circle cx="80" cy="80" r="15" fill="#1e3a8a" />
						<circle cx="80" cy="80" r="12" fill="#3b82f6" />

						{/* Handle bars */}
						<rect x="78" y="50" width="4" height="20" rx="2" fill="#1e3a8a" />
						<rect x="78" y="90" width="4" height="20" rx="2" fill="#1e3a8a" />
						<rect x="50" y="78" width="20" height="4" rx="2" fill="#1e3a8a" />
						<rect x="90" y="78" width="20" height="4" rx="2" fill="#1e3a8a" />
					</g>
				</g>

				{/* Success checkmark - shows when unlocked */}
				<g
					className={cn(
						"transition-all duration-500",
						state === "unlocked"
							? "scale-100 opacity-100"
							: "scale-50 opacity-0",
					)}
					style={{ transformOrigin: "80px 80px" }}
				>
					<circle cx="80" cy="80" r="30" fill="#10b981" />
					<path
						d="M65 80 L75 90 L95 70"
						stroke="white"
						strokeWidth="6"
						strokeLinecap="round"
						strokeLinejoin="round"
						fill="none"
					/>
				</g>

				{/* Gradients */}
				<defs>
					<linearGradient id="vaultGradient" x1="80" y1="5" x2="80" y2="155">
						<stop offset="0%" stopColor="#dbeafe" />
						<stop offset="100%" stopColor="#bfdbfe" />
					</linearGradient>
					<radialGradient id="doorShine" cx="50%" cy="30%">
						<stop offset="0%" stopColor="white" />
						<stop offset="100%" stopColor="white" stopOpacity="0" />
					</radialGradient>
				</defs>
			</svg>

			{/* Loading spinner for unlocking state */}
			{state === "unlocking" && (
				<div className="absolute inset-0 flex items-center justify-center">
					<div
						className="animate-spin rounded-full border-4 border-primary/20 border-t-primary"
						style={{ width: size * 0.85, height: size * 0.85 }}
					/>
				</div>
			)}
		</div>
	);
}
