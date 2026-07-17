import { type SVGProps, useId } from "react";

export interface IconFlagProps extends SVGProps<SVGSVGElement> {
	size?: number | string;
}

function IconFlagGermany({
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
			<title>Germany</title>
			<clipPath id={clipId}>
				<rect x="1" y="4" width="30" height="24" rx="4" ry="4" />
			</clipPath>
			<g clipPath={`url(#${clipId})`}>
				<rect x="1" y="4" width="30" height="8" fill="#000000" />
				<rect x="1" y="12" width="30" height="8" fill="#dd0000" />
				<rect x="1" y="20" width="30" height="8" fill="#ffce00" />
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

export default IconFlagGermany;
