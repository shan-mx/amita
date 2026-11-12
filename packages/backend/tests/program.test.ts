import { createAgent } from "./helpers";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { env, runInDurableObject } from "cloudflare:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import type { Env } from "../src/env";
import { ProgramTask, PROGRAM_EXTENSION } from "../src/agent/program";
import { modelFixture, owner } from "./helpers";

afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const model = modelFixture(() => ({ text: "UNEXPECTED_MODEL_REQUEST" }));
  const account = owner();
  await account.login();
  const created = await createAgent(account.client, {
    name: "Pure JavaScript probe",
    persona: "",
  });
  return { model, agent: (env as unknown as Env).AGENTS.getByName(created.agent.id) };
}
it("runs native Code Mode without any model request and captures JSON independently of truncated output", async () => {
  const { agent, model } = await fixture();
  const result = await runInDurableObject(agent, async (instance) => {
    const pi = await instance.harness.pi();
    const program = instance.registry.snapshot().extension(PROGRAM_EXTENSION)!;
    const conversation = await pi.createConversation(
      { ownership: { kind: "ownerless" }, agent: { extensions: { add: [program] } } },
      BG,
    );
    const code =
      '// @options: {"max_output_tokens":128}\ntext("x".repeat(20000)); return {runAgent:true,context:{value:42,locale:"中文",large:"x".repeat(70000)}};';
    const id = await conversation.commit(
      (tx) =>
        tx.createTask(
          ProgramTask,
          { code, captureReturn: true },
          { ownership: { kind: "conversation" } },
        ),
      BG,
    );
    pi.resume();
    return (await pi.waitForTask(id, BG)).state.outcome;
  });
  expect(model.requests).toEqual([]);
  expect(result).toMatchObject({
    status: "completed",
    result: {
      output: expect.stringContaining("Warning: truncated output"),
      returned: {
        runAgent: true,
        context: { value: 42, locale: "中文", large: "x".repeat(70000) },
      },
    },
  });
});
