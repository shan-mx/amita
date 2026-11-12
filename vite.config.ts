import { defineConfig } from "vite-plus";

const ignored = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.wrangler/**",
  ".scratch/**",
  "**/.dev.vars*",
  "**/.env*",
  "pnpm-lock.yaml",
  "packages/db/drizzle/**",
  "**/worker-configuration.d.ts",
];

export default defineConfig({
  defaultPackage: "./apps/web",
  fmt: {
    semi: true,
    singleQuote: false,
    tabWidth: 2,
    trailingComma: "all",
    printWidth: 100,
    ignorePatterns: ignored,
  },
  lint: {
    ignorePatterns: ignored,
    options: { typeAware: true, typeCheck: true },
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    overrides: [{ files: ["apps/web/src/**"], plugins: ["react"] }],
  },
  run: { cache: { scripts: false, tasks: true } },
});
