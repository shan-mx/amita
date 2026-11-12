import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "./http/router";

export type ApiClient = RouterClient<AppRouter>;
export type { AppRouter };
export type * from "./shared/types";

export type * from "./shared/automations";
export type * from "./models/schema";
export type { ModelCandidate } from "./models/discovery";
