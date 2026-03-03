declare module "*.mdx" {
	import type { ComponentType } from "react";
	const component: ComponentType;
	export default component;
	export const title: string;
	export const description: string;
	export const category: string;
	export const order: number | undefined;
}
