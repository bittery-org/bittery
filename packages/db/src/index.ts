import { drizzle } from "drizzle-orm/node-postgres";
import * as authSchema from "./schema/auth";
import * as sharingSchema from "./schema/sharing";
import * as syncSchema from "./schema/sync";
import * as teamSchema from "./schema/team";
import * as vaultSchema from "./schema/vault";

export const db = drizzle(process.env.DATABASE_URL || "", {
	schema: {
		...authSchema,
		...vaultSchema,
		...teamSchema,
		...sharingSchema,
		...syncSchema,
	},
});

export * from "./schema/auth";
export * from "./schema/sharing";
export * from "./schema/sync";
export * from "./schema/team";
export * from "./schema/vault";
