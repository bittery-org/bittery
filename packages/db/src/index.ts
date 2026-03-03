import { drizzle } from "drizzle-orm/node-postgres";
import * as authSchema from "./schema/auth";
import * as billingSchema from "./schema/billing";
import * as enumsSchema from "./schema/enums";
import * as rateLimitSchema from "./schema/rate-limit";
import * as sharingSchema from "./schema/sharing";
import * as syncSchema from "./schema/sync";
import * as teamSchema from "./schema/team";
import * as vaultSchema from "./schema/vault";

export const db = drizzle(process.env.DATABASE_URL || "", {
	schema: {
		...enumsSchema,
		...authSchema,
		...billingSchema,
		...vaultSchema,
		...teamSchema,
		...sharingSchema,
		...rateLimitSchema,
		...syncSchema,
	},
});

export * from "./schema/auth";
export * from "./schema/billing";
export * from "./schema/enums";
export * from "./schema/rate-limit";
export * from "./schema/sharing";
export * from "./schema/sync";
export * from "./schema/team";
export * from "./schema/vault";
