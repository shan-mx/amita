import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import type { Env } from "../src/env";

const bindings = env as unknown as Env;

function sandbox() {
  return new RemoteCodemodeSandbox({
    remote: () => bindings.CODEMODE_SANDBOX.getByName(crypto.randomUUID()),
  });
}

describe("native remote QuickJS Worker", () => {
  it("runs text and return over the real cross-Worker DO binding", async () => {
    const result = await sandbox().execute('text("native-remote"); return 6 * 7;');
    expect(result).toMatchObject({
      ok: true,
      value: 42,
      output: [{ type: "text", text: "native-remote" }],
    });
  });

  it("does not expose network, Worker bindings or host modules inside JavaScript", async () => {
    const result = await sandbox().execute(`return {
      fetch: typeof fetch,
      env: typeof env,
      process: typeof process,
      require: typeof require,
    };`);
    expect(result).toMatchObject({
      ok: true,
      value: { fetch: "undefined", env: "undefined", process: "undefined", require: "undefined" },
    });
  });
});
