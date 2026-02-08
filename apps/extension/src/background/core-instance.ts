import { createCoreContext } from "@bittery/core";
import { cryptoAdapter } from "../lib/crypto-adapter";
import { storage } from "../lib/storage";

export const core = createCoreContext({
	storage,
	crypto: cryptoAdapter,
});
