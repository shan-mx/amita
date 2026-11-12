import { createAgent } from "./helpers";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  env,
  runInDurableObject,
  evictDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import {
  appendMessage,
  automationTriggerSoon,
  codemodeToolCall,
  owner,
  modelFixture,
  WAIT,
} from "./helpers";
import type { Env } from "../src/env";
import type { AutomationWrite, AutomationRunPage } from "../src/shared/automations";
afterEach(() => vi.restoreAllMocks());

const future = () => new Date(Date.now() + 60000).toISOString();

const definition = (patch: Partial<AutomationWrite> = {}): AutomationWrite => ({
  name: "API fixture",
  timezone: "Asia/Taipei",
  trigger: { type: "once", runAt: future() },
  script: "return 42;",
  enabled: false,
  ...patch,
});
async function fixture() {
  const account = owner();
  await account.login();
  const created = await createAgent(account.client, { name: "Automation fixture", persona: "" });
  const api = account.client.automations;
  const agentId = created.agent.id;
  const create = (patch: Partial<AutomationWrite> = {}) =>
    api.create({
      agentId,
      id: crypto.randomUUID(),
      definition: definition({ enabled: true, trigger: automationTriggerSoon(), ...patch }),
    });
  const run = async (id: string) => {
    let run: AutomationRunPage["runs"][number] | undefined;
    await vi.waitFor(async () => {
      run = (await api.history({ agentId, id })).runs[0];
      expect(run?.status).not.toBe("running");
      expect(run).toBeDefined();
    }, WAIT);
    return run!;
  };
  return { account, api, agentId, created, create, run };
}
it("runs pure JavaScript without a model and keeps its internal Conversations out of chat", async () => {
  const model = modelFixture(() => ({ text: "UNEXPECTED_MODEL_REQUEST" }));
  const account = owner();
  await account.login();
  const agent = (await createAgent(account.client, { name: "Automation JavaScript", persona: "" }))
    .agent;
  const api = account.client.automations;
  const before = await account.client.sessions.list({ agentId: agent.id });
  const id = crypto.randomUUID();
  const automation = await api.create({
    agentId: agent.id,
    id,
    definition: {
      name: "Pure JS",
      timezone: "Asia/Taipei",
      trigger: automationTriggerSoon(),
      script: 'text("automation-js");return {answer:6*7};',
      enabled: true,
    },
  });
  expect(automation.definition.timezone).toBe("Asia/Taipei");
  let history: AutomationRunPage = { runs: [] };
  await vi.waitFor(async () => {
    history = await api.history({ agentId: agent.id, id });
    expect(history.runs[0]?.status).toBe("succeeded");
  }, WAIT);
  expect(history.runs).toHaveLength(1);
  expect(history.runs[0].output).toContain("automation-js");
  expect(history.runs[0].output).toContain('"answer":42');
  expect(await account.client.sessions.list({ agentId: agent.id })).toEqual(before);
  expect(model.requests).toEqual([]);
});

it("merges concurrent edits and preserves stable IDs for create retries", async () => {
  modelFixture(() => ({ text: "UNEXPECTED_MODEL_REQUEST" }));
  const f = await fixture();
  const id = crypto.randomUUID();
  const input = definition({ enabled: true });
  const first = await f.api.create({ agentId: f.agentId, id, definition: input });
  await expect(f.api.update({ agentId: f.agentId, id, patch: {} })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  expect(await f.api.get({ agentId: f.agentId, id })).toEqual(first);
  expect(await f.api.create({ agentId: f.agentId, id, definition: input })).toEqual(first);
  await expect(
    f.api.create({ agentId: f.agentId, id, definition: { ...input, name: "Different intent" } }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await Promise.all([
    f.api.update({ agentId: f.agentId, id, patch: { name: "Latest owner edit" } }),
    f.api.update({ agentId: f.agentId, id, patch: { enabled: false } }),
  ]);
  expect((await f.api.get({ agentId: f.agentId, id })).definition).toMatchObject({
    name: "Latest owner edit",
    enabled: false,
  });
  await expect(
    f.api.history({ agentId: f.agentId, id, cursor: "invalid-json" }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(f.api.remove({ agentId: f.agentId, id })).resolves.toEqual({ removed: true });
  await expect(f.api.get({ agentId: f.agentId, id })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("distinguishes skipped and invalid guards without calling the model", async () => {
  const model = modelFixture(() => ({ text: "UNEXPECTED_MODEL_REQUEST" }));
  const f = await fixture();
  const skipped = await f.create({
    script: 'text("no-new-data");return {runAgent:false};',
    prompt: "Should not run.",
  });
  const invalid = await Promise.all(
    ["return true;", "return;", "return null;"].map((script) =>
      f.create({ script, prompt: "Should not run." }),
    ),
  );
  expect(await f.run(skipped.id)).toMatchObject({
    status: "skipped",
    output: expect.stringContaining("no-new-data"),
  });
  for (const item of invalid)
    expect(await f.run(item.id)).toMatchObject({
      status: "failed",
      error: "JavaScript must return an object with runAgent: boolean and optional JSON context.",
    });
  expect(await f.account.client.sessions.list({ agentId: f.agentId })).toHaveLength(1);
  expect(model.requests).toEqual([]);
});

it("passes guard context to a fresh visible Session, honors its model, and permits normal follow-up", async () => {
  const model = modelFixture(() => ({ text: "AUTOMATION_AGENT_DONE" }));
  const f = await fixture();
  const options = await f.api.options({ agentId: f.agentId });
  const selected = options.models.find((item) => item.id === "deepseek-v4-pro")!;
  expect(selected).toBeDefined();
  const automation = await f.create({
    script: 'return {runAgent:true,context:{pending:3,locale:"中文"}};',
    prompt: "Summarize the pending items.",
    execution: {
      kind: "new_session",
      model: { provider: selected.provider, modelId: selected.id },
    },
  });
  const run = await f.run(automation.id);
  expect(run.status).toBe("succeeded");
  expect(run.sessionId).toBeDefined();
  expect(model.requests).toHaveLength(1);
  expect(model.requests[0].model).toBe(selected.id);
  const user = model.requests[0].messages.find((message) => message.role === "user");
  expect(user?.content).toContain('"pending":3');
  const sessions = await f.account.client.sessions.list({ agentId: f.agentId });
  expect(sessions).toHaveLength(2);
  expect(sessions.find((item) => item.id === run.sessionId)).toMatchObject({
    title: "Automation: API fixture",
    modelLabel: selected.name,
  });
  await f.account.client.sessions.submit({
    agentId: f.agentId,
    sessionId: run.sessionId!,
    operationId: crypto.randomUUID(),
    text: "Continue normally.",
    timezone: "America/New_York",
  });
  await vi.waitFor(() => expect(model.requests).toHaveLength(2), WAIT);
});

it("resumes the admitted Agent submission after the Harness reopens", async () => {
  let interrupted = false;
  const model = modelFixture((_body, signal) => {
    if (interrupted) return { text: "Recovered" };
    return new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          interrupted = true;
          reject(signal.reason);
        },
        { once: true },
      );
    });
  });
  const f = await fixture();
  const automation = await f.create({ script: null, prompt: "Run the report." });
  await vi.waitFor(() => expect(model.requests).toHaveLength(1), WAIT);
  const runId = (await f.api.history({ agentId: f.agentId, id: automation.id })).runs[0].id;
  const agent = (env as unknown as Env).AGENTS.getByName(f.agentId);
  await runInDurableObject(agent, async (instance) => {
    await instance.harness.dispose();
    (await instance.harness.pi()).resume();
  });
  await vi.waitFor(async () => {
    const history = await f.api.history({ agentId: f.agentId, id: automation.id });
    expect(history.runs).toMatchObject([{ id: runId, status: "succeeded" }]);
  }, WAIT);
});

it("wakes an evicted Agent from its durable alarm and runs a scheduled automation once", async () => {
  const model = modelFixture(() => ({ text: "UNEXPECTED_MODEL_REQUEST" }));
  const f = await fixture();
  const at = Date.now() + 60000;
  const item = await f.create({
    enabled: true,
    trigger: { type: "once", runAt: new Date(at).toISOString() },
    script: 'text("ALARM_RECOVERED");',
  });
  const agent = (env as unknown as Env).AGENTS.getByName(f.agentId);
  await vi.waitFor(async () => {
    expect(
      await runInDurableObject(agent, (_instance, state) => state.storage.getAlarm()),
    ).not.toBeNull();
  }, WAIT);
  await evictDurableObject(agent);
  vi.spyOn(Date, "now").mockReturnValue(at + 1);
  expect(await runDurableObjectAlarm(agent)).toBe(true);
  await vi.waitFor(async () => {
    const { runs } = await f.api.history({ agentId: f.agentId, id: item.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "succeeded",
      scheduledAt: at,
      output: expect.stringContaining("ALARM_RECOVERED"),
    });
  }, WAIT);
  expect(model.requests).toEqual([]);
});

it("runs a pure prompt with the ordinary Agent tools and a visible Session", async () => {
  const model = modelFixture(({ messages }) =>
    messages.some((message) => message.role === "tool")
      ? { text: "PROMPT_AUTOMATION_DONE" }
      : { tool: codemodeToolCall("computer_list", {}) },
  );
  const f = await fixture();
  const item = await f.create({ script: null, prompt: "List registered computers." });
  const run = await f.run(item.id);
  expect(run).toMatchObject({
    status: "succeeded",
    sessionId: expect.any(String),
  });
  expect(run).not.toHaveProperty("uncertain");
  const history = await f.account.client.sessions.history({
    agentId: f.agentId,
    sessionId: run.sessionId!,
  });
  expect(JSON.stringify(history)).toContain("PROMPT_AUTOMATION_DONE");
  expect(model.requests).toHaveLength(2);
});

it("runs repeated messages in the selected Session using its history without changing its metadata", async () => {
  const model = modelFixture(() => ({ text: "SELECTED_SESSION_RESULT" }));
  const f = await fixture();
  const sessionId = f.created.sessionId;
  const selected = (await f.account.client.providers.models()).find(
    ({ id }) => id === "deepseek-v4-pro",
  );
  if (!selected) throw new Error("Missing alternate fixture model");
  await f.account.client.sessions.setModel({
    agentId: f.agentId,
    sessionId,
    model: { provider: selected.provider, modelId: selected.id },
  });
  await f.account.client.sessions.update({
    agentId: f.agentId,
    sessionId,
    title: "Ongoing report",
    archived: true,
  });
  await appendMessage(f.agentId, sessionId, "user", "Remember project Orion.");
  await appendMessage(f.agentId, sessionId, "assistant", "Project Orion is the active project.");
  const automation = await f.create({
    script: null,
    prompt: "Report on the active project.",
    execution: { kind: "existing_session", sessionId },
  });
  expect(await f.run(automation.id)).toMatchObject({ status: "succeeded", sessionId });
  await f.api.update({
    agentId: f.agentId,
    id: automation.id,
    patch: { trigger: automationTriggerSoon() },
  });
  await vi.waitFor(async () => {
    const { runs } = await f.api.history({ agentId: f.agentId, id: automation.id });
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.status === "succeeded" && run.sessionId === sessionId)).toBe(
      true,
    );
  }, WAIT);
  expect(model.requests).toHaveLength(2);
  expect(model.requests.map(({ model }) => model)).toEqual([selected.id, selected.id]);
  expect(JSON.stringify(model.requests[0].messages)).toContain("Remember project Orion.");
  expect(JSON.stringify(model.requests[1].messages)).toContain("SELECTED_SESSION_RESULT");
  expect(
    await f.account.client.sessions.list({ agentId: f.agentId, archived: true }),
  ).toMatchObject([{ id: sessionId, title: "Ongoing report", archived: true }]);
  expect(await f.account.client.sessions.list({ agentId: f.agentId })).toHaveLength(0);
});

it("creates independent Sessions on successive isolated runs", async () => {
  const model = modelFixture(() => ({ text: "PREVIOUS_ISOLATED_RESULT" }));
  const f = await fixture();
  const automation = await f.create({ script: null, prompt: "Produce an independent report." });
  const first = await f.run(automation.id);
  await f.api.update({
    agentId: f.agentId,
    id: automation.id,
    patch: { trigger: automationTriggerSoon() },
  });
  await vi.waitFor(async () => {
    const { runs } = await f.api.history({ agentId: f.agentId, id: automation.id });
    expect(runs).toHaveLength(2);
    expect(runs[0].status).toBe("succeeded");
    expect(runs[0].sessionId).not.toBe(first.sessionId);
  }, WAIT);
  expect(JSON.stringify(model.requests[1].messages)).not.toContain("PREVIOUS_ISOLATED_RESULT");
});

it("rejects missing Sessions and configuration that overrides an existing Session's model", async () => {
  modelFixture(() => ({ text: "Unexpected request" }));
  const f = await fixture();
  const invalidOverride = {
    kind: "existing_session" as const,
    sessionId: f.created.sessionId,
    model: { provider: "openai-compatible", modelId: "deepseek-v4-pro" },
  };
  for (const patch of [
    {
      script: null,
      prompt: "Report",
      execution: { kind: "existing_session", sessionId: "999999" },
    },
    {
      script: null,
      prompt: "Report",
      execution: invalidOverride,
    },
    { execution: { kind: "existing_session", sessionId: f.created.sessionId } },
  ] satisfies Partial<AutomationWrite>[])
    await expect(f.create(patch)).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

it("rejects a busy Session without steering or cancelling its current work", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = modelFixture(async () => {
    await hold;
    return { text: "MANUAL_WORK_FINISHED" };
  });
  const f = await fixture();
  await f.account.client.sessions.submit({
    agentId: f.agentId,
    sessionId: f.created.sessionId,
    operationId: crypto.randomUUID(),
    text: "Hold the manual task.",
  });
  await vi.waitFor(() => expect(model.requests).toHaveLength(1), WAIT);
  try {
    const automation = await f.create({
      script: null,
      prompt: "AUTOMATION_MUST_NOT_STEER",
      execution: { kind: "existing_session", sessionId: f.created.sessionId },
    });
    expect(await f.run(automation.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("busy"),
    });
    expect(model.requests).toHaveLength(1);
    expect(await f.api.stop({ agentId: f.agentId, id: automation.id })).toEqual({ stopped: false });
    expect((await f.account.client.sessions.list({ agentId: f.agentId }))[0].busy).toBe(true);
  } finally {
    release();
  }
  await vi.waitFor(
    async () =>
      expect((await f.account.client.sessions.list({ agentId: f.agentId }))[0].busy).toBe(false),
    WAIT,
  );
  const history = await f.account.client.sessions.history({
    agentId: f.agentId,
    sessionId: f.created.sessionId,
  });
  expect(JSON.stringify(history)).toContain("MANUAL_WORK_FINISHED");
  expect(JSON.stringify(history)).not.toContain("AUTOMATION_MUST_NOT_STEER");
});

it("stops its active input and leaves later work in the same Session alone", async () => {
  let stopped = false;
  const model = modelFixture((_body, signal) => {
    if (stopped) return { text: "LATER_MANUAL_RESULT" };
    return new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          stopped = true;
          reject(signal.reason);
        },
        { once: true },
      );
    });
  });
  const f = await fixture();
  const automation = await f.create({
    script: null,
    prompt: "Hold this automation.",
    execution: { kind: "existing_session", sessionId: f.created.sessionId },
  });
  await vi.waitFor(() => expect(model.requests).toHaveLength(1), WAIT);
  expect(await f.api.stop({ agentId: f.agentId, id: automation.id })).toEqual({ stopped: true });
  expect(await f.run(automation.id)).toMatchObject({ status: "cancelled" });
  await f.account.client.sessions.submit({
    agentId: f.agentId,
    sessionId: f.created.sessionId,
    operationId: crypto.randomUUID(),
    text: "A later manual request.",
  });
  await vi.waitFor(() => expect(model.requests).toHaveLength(2), WAIT);
  expect(await f.api.stop({ agentId: f.agentId, id: automation.id })).toEqual({ stopped: false });
  await vi.waitFor(async () => {
    const history = await f.account.client.sessions.history({
      agentId: f.agentId,
      sessionId: f.created.sessionId,
    });
    expect(JSON.stringify(history)).toContain("LATER_MANUAL_RESULT");
  }, WAIT);
});
