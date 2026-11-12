import type { Env } from "../env";

export const directory = (env: Env) => env.DEPLOYMENT.get(env.DEPLOYMENT.idFromName("deployment"));
