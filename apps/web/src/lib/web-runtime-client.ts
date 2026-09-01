import { runtimeClient } from "./crypto";
import { withRuntimeImportParkingLifecycle } from "./runtime-import-lifecycle";

/** The process-wide Runtime client with Web-owned ephemeral lifecycle cleanup. */
export const webRuntimeClient =
	withRuntimeImportParkingLifecycle(runtimeClient);
