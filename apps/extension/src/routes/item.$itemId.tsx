import { createRoute } from "@tanstack/react-router";
import { Route as RootRoute } from "./__root";
import { ItemDetailPage } from "../pages/item-detail";

export const Route = createRoute({
	getParentRoute: () => RootRoute,
	path: "/item/$itemId",
	component: ItemDetailPage,
});
