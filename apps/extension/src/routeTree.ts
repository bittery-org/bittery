// Generated route tree for TanStack Router
import { Route as rootRoute } from "./routes/__root";
import { Route as indexRoute } from "./routes/index";
import { Route as loginRoute } from "./routes/login";
import { Route as unlockRoute } from "./routes/unlock";
import { Route as vaultRoute } from "./routes/vault";
import { Route as itemDetailRoute } from "./routes/item.$itemId";

export const routeTree = rootRoute.addChildren([
	indexRoute,
	loginRoute,
	unlockRoute,
	vaultRoute,
	itemDetailRoute,
]);
