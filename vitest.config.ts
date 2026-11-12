import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

const sandboxRoot = fileURLToPath(new URL("./dist/codemode/", import.meta.url));
const wasm = (root: string): string[] =>
  readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return wasm(path);
    return entry.name.endsWith(".wasm") ? [path] : [];
  });

export default defineConfig({
  test: {
    include: ["{apps,packages}/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    maxWorkers: 2,
    fsModuleCache: false,
    testTimeout: 15_000,
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./packages/backend/tests/wrangler.jsonc" },
      miniflare: {
        workers: [
          {
            name: "amita-codemode-sandbox",
            compatibilityDate: "2026-11-03",
            compatibilityFlags: ["nodejs_compat"],
            modulesRoot: sandboxRoot,
            modules: [
              { type: "ESModule", path: `${sandboxRoot}/index.js` },
              ...wasm(sandboxRoot).map((path) => ({
                type: "CompiledWasm" as const,
                path,
              })),
            ],
            durableObjects: {
              CODEMODE_SANDBOX: {
                className: "CodemodeSandboxDurableObject",
                useSQLite: true,
              },
            },
          },
        ],
      },
    }),
  ],
});
