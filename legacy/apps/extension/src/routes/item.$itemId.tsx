import { createRoute } from "@tanstack/react-router";
import { ItemDetailPage } from "../pages/item-detail";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
	getParentRoute: () => RootRoute,
	path: "/item/$itemId",
	component: ItemDetailPage,
});
