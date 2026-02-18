import type { SVGProps } from "react";

export interface IconProps extends SVGProps<SVGSVGElement> {
	size?: string;
}

function IconLoader2Fill18({ size = "18px", ...props }: IconProps) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			x="0px"
			y="0px"
			width={size}
			height={size}
			viewBox="0 0 18 18"
			{...props}
		>
			<title>Loader 2 Fill</title>
			<path
				d="M17 9C17 4.58172 13.4183 1 9 1V2.5C12.5899 2.5 15.5 5.41015 15.5 9C15.5 12.5899 12.5899 15.5 9 15.5V17C13.4183 17 17 13.4183 17 9Z"
				fill="url(#j4861xxjxk-nc-loader-2-fill-gradient-1)"
			/>
			<path
				d="M2.5 9C2.5 5.41015 5.41015 2.5 9 2.5V1C4.58172 1 1 4.58172 1 9C1 13.4183 4.58172 17 9 17V15.5C5.41015 15.5 2.5 12.5899 2.5 9Z"
				fill="url(#j4861xxjxk-nc-loader-2-fill-gradient-2)"
			/>
			<circle
				cx="9"
				cy="16.25"
				r="0.75"
				fill="currentColor"
				data-color="color-2"
			/>
			<defs fill="none">
				<linearGradient
					id="j4861xxjxk-nc-loader-2-fill-gradient-1"
					x1="9"
					y1="2.5"
					x2="9"
					y2="16.25"
					gradientUnits="userSpaceOnUse"
					fill="none"
				>
					<stop stopColor="currentColor" stopOpacity="0.5" fill="none" />
					<stop stopColor="currentColor" offset="1" fill="none" />
				</linearGradient>
				<linearGradient
					id="j4861xxjxk-nc-loader-2-fill-gradient-2"
					x1="9"
					y1="2.5"
					x2="9"
					y2="16.25"
					gradientUnits="userSpaceOnUse"
					fill="none"
				>
					<stop stopColor="currentColor" stopOpacity="0.5" fill="none" />
					<stop
						stopColor="currentColor"
						offset="1"
						stopOpacity="0"
						fill="none"
					/>
				</linearGradient>
			</defs>
		</svg>
	);
}

export default IconLoader2Fill18;
