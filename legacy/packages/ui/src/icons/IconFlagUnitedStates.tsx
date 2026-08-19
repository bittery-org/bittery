import { type SVGProps, useId } from "react";

export interface IconFlagProps extends SVGProps<SVGSVGElement> {
	size?: number | string;
}

const STRIPE_HEIGHT = 24 / 13;
const RED_STRIPES = [0, 2, 4, 6, 8, 10, 12];

// The canton spans the upper seven stripes and two fifths of the flag's width.
const CANTON_WIDTH = 12;
const CANTON_HEIGHT = STRIPE_HEIGHT * 7;

// At the 14px this renders at, individual five-pointed stars turn to mush, so
// the canton uses a simplified dot grid instead.
const STAR_COLUMNS = [2.7, 4.8, 6.9, 9.0, 11.1];
const STAR_ROWS = [5.6, 8.0, 10.4, 12.8];

function IconFlagUnitedStates({
	size = 32,
	width,
	height,
	...props
}: IconFlagProps) {
	const clipId = useId();

	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width={width ?? size}
			height={height ?? size}
			viewBox="0 0 32 32"
			{...props}
		>
			<title>United States</title>
			<clipPath id={clipId}>
				<rect x="1" y="4" width="30" height="24" rx="4" ry="4" />
			</clipPath>
			<g clipPath={`url(#${clipId})`}>
				<rect x="1" y="4" width="30" height="24" fill="#ffffff" />
				{RED_STRIPES.map((stripe) => (
					<rect
						key={stripe}
						x="1"
						y={4 + stripe * STRIPE_HEIGHT}
						width="30"
						height={STRIPE_HEIGHT}
						fill="#b22234"
					/>
				))}
				<rect
					x="1"
					y="4"
					width={CANTON_WIDTH}
					height={CANTON_HEIGHT}
					fill="#3c3b6e"
				/>
				{STAR_ROWS.flatMap((cy, row) => {
					// Odd rows sit half a column in and carry one fewer star, giving
					// the staggered grid of the real canton.
					const offset = row % 2 === 0 ? 0 : 1.05;
					const columns =
						row % 2 === 0 ? STAR_COLUMNS : STAR_COLUMNS.slice(0, -1);
					return columns.map((cx) => (
						<circle
							key={`${cy}-${cx}`}
							cx={cx + offset}
							cy={cy}
							r="0.6"
							fill="#ffffff"
						/>
					));
				})}
			</g>
			<rect
				x="1"
				y="4"
				width="30"
				height="24"
				rx="4"
				ry="4"
				fill="none"
				stroke="#000000"
				strokeOpacity="0.15"
			/>
		</svg>
	);
}

export default IconFlagUnitedStates;
