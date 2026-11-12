import { spawn } from "node:child_process";
import { getDefaultDevRegistryPath } from "miniflare";

const child = spawn(
  "pnpm",
  [
    "exec",
    "vp",
    "run",
    "--parallel",
    "--filter",
    "@amita/web",
    "--filter",
    "@amita/codemode-sandbox",
    "dev",
  ],
  {
    env: {
      ...process.env,
      WRANGLER_REGISTRY_PATH: process.env.WRANGLER_REGISTRY_PATH ?? getDefaultDevRegistryPath(),
    },
    stdio: "inherit",
  },
);
const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
for (const signal of signals) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 0;
});
