import type { Agent } from "./agent/agent";
import type { Deployment } from "./deployment/deployment";
import type { Computer } from "./computer/computer";
import type { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";

export interface Env {
  DEPLOYMENT: DurableObjectNamespace<Deployment>;
  AGENTS: DurableObjectNamespace<Agent>;
  COMPUTERS: DurableObjectNamespace<Computer>;
  CODEMODE_SANDBOX: DurableObjectNamespace<CodemodeSandboxDurableObject>;
  LOGIN_RATE_LIMITER: RateLimit;
  ASSETS: Fetcher;
  AMITA_OWNER_PASSWORD: string;
  AMITA_CREDENTIAL_ENCRYPTION_KEY?: string;
}
