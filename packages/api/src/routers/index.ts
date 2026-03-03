import { protectedProcedure, publicProcedure, router } from "../index";
import { auditRouter } from "./audit";
import { authRouter } from "./auth";
import { billingRouter } from "./billing";
import { shareRouter } from "./share";
import { syncRouter } from "./sync";
import { teamRouter } from "./team";
import { vaultRouter } from "./vault";

export const appRouter = router({
	healthCheck: publicProcedure.query(() => {
		return "OK";
	}),
	audit: auditRouter,
	billing: billingRouter,
	privateData: protectedProcedure.query(({ ctx }) => {
		return {
			message: "This is private",
			user: ctx.session,
		};
	}),
	auth: authRouter,
	team: teamRouter,
	vault: vaultRouter,
	share: shareRouter,
	sync: syncRouter,
});
export type AppRouter = typeof appRouter;
