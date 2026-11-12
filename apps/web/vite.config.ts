import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig(({ command }) => ({
  plugins: [
    {
      name: "durable-sqlite-migrations",
      enforce: "pre",
      transform(code, id) {
        if (id.endsWith("/drizzle/migrations.js"))
          return {
            code: code.replace(/(from\s+["'])([^"']+\.sql)(["'])/g, "$1$2?raw$3"),
            map: null,
          };
      },
    },
    react(),
    tailwindcss(),
    cloudflare({
      configPath: "../../wrangler.jsonc",
      inspectorPort: 0,
      persistState: { path: fileURLToPath(new URL("../../.wrangler/state", import.meta.url)) },
      auxiliaryWorkers:
        command === "build"
          ? [
              {
                configPath: "../codemode-sandbox/wrangler.jsonc",
                viteEnvironment: { name: "codemode" },
              },
            ]
          : [],
    }),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "../../dist", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
}));
