import { afterEach, expect, it, vi } from "vite-plus/test";
import { env } from "cloudflare:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { obj, str } from "@earendil-works/pi-schema";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineTool,
  type SetTimer,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import { Automations } from "../src/automations/automations";
import { automationTools } from "../src/automations/automation-tools";
import { createProgramExtension, ProgramTask } from "../src/agent/program";
import type { Env } from "../src/env";
import type { AutomationWrite, AutomationRunInfo } from "../src/shared/automations";
import { WAIT } from "./helpers";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

async function fixture() {
  let now = Date.parse("2026-11-08T00:00:00Z");
  const timers = new Map<object, { at: number; callback: () => void }>();
  const setTimer: SetTimer = (callback, delay, options) => {
    if (options.background) return undefined;
    const key = {};
    timers.set(key, { at: now + delay, callback });
    return () => {
      timers.delete(key);
    };
  };
  const flush = () => {
    for (const [key, timer] of [...timers].filter(([, value]) => value.at <= now)) {
      timers.delete(key);
      timer.callback();
    }
  };
  const memory = new MemoryStorage();
  // A host reopen replaces the Harness while retaining its persisted storage.
  const storage = new Proxy(memory, {
    get(target, key) {
      if (key === "close") return async () => {};
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const calls: { taskId: number; mode: string }[] = [];
  const releases: (() => void)[] = [];
  let aborted = 0;
  const probe = defineTool({
    name: "automation_probe",
    description: "Controlled external operation for Automation lifecycle tests.",
    parameters: obj({ mode: str() }),
    execute: async ({ mode }, api, context) => {
      calls.push({ taskId: api.taskId, mode });
      if (mode === "hold")
        await new Promise<void>((resolve) => {
          releases.push(resolve);
          const cancel = () => {
            aborted++;
            resolve();
          };
          if (context.abortSignal?.aborted) cancel();
          else context.abortSignal?.addEventListener("abort", cancel, { once: true });
        });
      if (mode === "unknown")
        return {
          output: [],
          isError: true,
          diagnostics: [
            {
              severity: "error",
              code: "unknown",
              message: "Effect receipt was not confirmed.",
            },
          ],
        };
      return { output: [{ type: "text", text: `${mode}:${api.taskId}` }] };
    },
  });
  const registry = createRegistry();
  const models = createModels();
  let pi: Harness;
  const automations = new Automations({
    pi: async () => pi,
    now: () => now,
    models: async () => ({
      inheritedModel: null,
      models: [],
    }),
    baseline: async () => ({ persona: "", memory: "", computers: [], skills: [] }),
    prepareInput: async (conversation, draft) => async (tx) => ({
      submissionId: await conversation.submit(tx, draft),
    }),
  });
  const extension = { name: "automation-fixture", tools: [probe, ...automationTools(automations)] };
  const sandbox = new RemoteCodemodeSandbox({
    remote: () => (env as unknown as Env).CODEMODE_SANDBOX.getByName(crypto.randomUUID()),
  });
  const codemode = createCodemodeExtension({ sandbox, models: false });
  registry.install(extension);
  registry.install(codemode);
  const program = createProgramExtension(sandbox);
  registry.install(program);
  registry.install(automations.extension());
  const open = async () => {
    pi = await Harness.open(
      storage,
      {
        registry,
        models,
        settings: { extensions: [extension, codemode] },
        now: () => now,
        setTimer,
      },
      BG,
    );
  };
  await open();
  cleanups.push(async () => {
    await pi.close(BG);
    timers.clear();
  });
  const advance = (milliseconds: number) => {
    now += milliseconds;
    flush();
    pi.resume();
  };
  const create = (patch: Partial<AutomationWrite> = {}) =>
    automations.create(crypto.randomUUID(), {
      name: "Runtime fixture",
      timezone: "Asia/Taipei",
      trigger: { type: "cron", expression: "* * * * *" },
      script: 'await tools.automation_probe({mode:"effect"});',
      enabled: true,
      ...patch,
    });
  const latestRunId = async (automationId: string, scheduledAt = now) => {
    let id: string | undefined;
    await vi.waitFor(async () => {
      id = (await automations.history(automationId)).runs.find(
        (run) => run.scheduledAt === scheduledAt,
      )?.id;
      expect(id).toBeDefined();
    }, WAIT);
    return id!;
  };
  const terminal = async (automationId: string, runId: string) => {
    let result: AutomationRunInfo | undefined;
    await vi.waitFor(async () => {
      flush();
      result = (await automations.history(automationId)).runs.find((run) => run.id === runId);
      expect(result?.status).not.toBe("running");
      expect(result).toBeDefined();
    }, WAIT);
    return result!;
  };
  return {
    automations,
    create,
    terminal,
    latestRunId,
    calls,
    program,
    releases,
    advance,
    get now() {
      return now;
    },
    get pi() {
      return pi;
    },
    get aborted() {
      return aborted;
    },
    reopen: async () => {
      await pi.close(BG);
      timers.clear();
      await open();
      pi.resume();
    },
  };
}

it("resumes the native clock after reopen and coalesces missed trigger opportunities", async () => {
  const f = await fixture();
  const automation = await f.create({ enabled: true });
  await vi.waitFor(() => expect(f.pi.wake().at).toBe(f.now + 60000), WAIT);
  await f.reopen();
  f.advance(7 * 60000 + 30000);
  await vi.waitFor(() => expect(f.calls).toHaveLength(1), WAIT);
  const first = (await f.automations.history(automation.id)).runs[0];
  expect((await f.terminal(automation.id, first.id)).scheduledAt).toBe(
    Date.parse("2026-11-08T00:07:00Z"),
  );
  await vi.waitFor(() => expect(f.pi.wake().at).toBe(Date.parse("2026-11-08T00:08:00Z")), WAIT);
  expect(f.calls).toHaveLength(1);
});

it("prevents reentry for one automation while allowing other automations to run independently", async () => {
  const f = await fixture();
  const first = await f.create({
    enabled: true,
    script: 'await tools.automation_probe({mode:"hold"});',
  });
  const second = await f.create({
    trigger: { type: "once", runAt: new Date(f.now + 60_000).toISOString() },
  });
  f.advance(60_000);
  const firstRun = await f.latestRunId(first.id);
  const otherRun = await f.latestRunId(second.id);
  expect((await f.terminal(second.id, otherRun)).status).toBe("succeeded");
  await vi.waitFor(() => expect(f.releases).toHaveLength(1), WAIT);
  f.advance(3 * 60_000 + 30_000);
  await f.automations.update(first.id, {
    name: "Updated without moving the schedule",
    enabled: true,
  });
  expect(f.calls).toHaveLength(2);
  f.releases[0]();
  expect((await f.terminal(first.id, firstRun)).status).toBe("succeeded");
  await vi.waitFor(() => expect(f.calls).toHaveLength(3), WAIT);
  const runs = (await f.automations.history(first.id)).runs;
  expect(runs).toHaveLength(2);
  expect(runs[0]).toMatchObject({
    scheduledAt: Date.parse("2026-11-08T00:04:00Z"),
    automationName: "Updated without moving the schedule",
  });
  f.releases[1]();
  await f.terminal(first.id, runs[0].id);
});

it("pauses future triggers without cancelling admitted work and resumes from the new cursor", async () => {
  const f = await fixture();
  let automation = await f.create({
    enabled: true,
    script: 'await tools.automation_probe({mode:"hold"});',
  });
  f.advance(60_000);
  const runId = await f.latestRunId(automation.id);
  await vi.waitFor(() => expect(f.calls).toHaveLength(1), WAIT);
  automation = await f.automations.update(automation.id, { enabled: false });
  f.advance(120_000);
  expect(f.aborted).toBe(0);
  f.releases[0]();
  await f.terminal(automation.id, runId);
  expect(f.calls).toHaveLength(1);
  automation = await f.automations.update(automation.id, { enabled: true });
  expect(automation.nextRun).toBe(Date.parse("2026-11-08T00:04:00Z"));
  expect(f.calls).toHaveLength(1);
});

it("keeps native script failure handling when a child error was caught", async () => {
  const f = await fixture();
  const automation = await f.create({
    script:
      'try {await tools.automation_probe({mode:"unknown"});} catch {} throw new Error("failed after unknown");',
  });
  f.advance(60_000);
  const runId = await f.latestRunId(automation.id);
  const run = await f.terminal(automation.id, runId);
  expect(run.status).toBe("failed");
  expect(run.error).toContain("failed after unknown");
  expect(f.calls).toHaveLength(1);
});

it("continues past the former total execution timeout and stops by automation ID", async () => {
  const f = await fixture();
  const automation = await f.create({
    trigger: { type: "once", runAt: new Date(f.now + 60_000).toISOString() },
    script: 'await tools.automation_probe({mode:"hold"});',
  });
  f.advance(60_000);
  const runId = await f.latestRunId(automation.id);
  await vi.waitFor(() => expect(f.calls).toHaveLength(1), WAIT);
  f.advance(301000);
  expect((await f.automations.history(automation.id)).runs[0].status).toBe("running");
  expect(f.aborted).toBe(0);
  expect(await f.automations.stop(automation.id)).toEqual({ stopped: true });
  expect((await f.terminal(automation.id, runId)).status).toBe("cancelled");
  expect(f.aborted).toBe(1);
  expect(await f.automations.stop(automation.id)).toEqual({ stopped: false });
});

it("paginates native run history without repeating or dropping a run", async () => {
  const f = await fixture();
  const automation = await f.create({ script: "return 42;" });
  const admitted: string[] = [];
  for (let i = 0; i < 21; i++) {
    f.advance(60_000);
    const runId = await f.latestRunId(automation.id);
    admitted.push(runId);
    await f.terminal(automation.id, runId);
  }
  const first = await f.automations.history(automation.id);
  expect(first.runs).toHaveLength(20);
  expect(first.cursor).toBeDefined();
  const second = await f.automations.history(automation.id, first.cursor);
  expect(second.runs).toHaveLength(1);
  expect([...first.runs, ...second.runs].map((run) => run.id)).toEqual(admitted.toReversed());
}, 30000);

it("replays a committed automation creation without creating another child", async () => {
  const f = await fixture();
  const parent = await f.create({
    script: `const child=await tools.automation({action:"create",job:{name:"Replay child",trigger:{type:"cron",expression:"0 9 * * *"},script:"return 42;",enabled:false}});text(child.id);try {await tools.automation_probe({mode:"hold"});} catch {}`,
  });
  f.advance(60_000);
  const runId = await f.latestRunId(parent.id);
  await vi.waitFor(() => expect(f.calls).toHaveLength(1), WAIT);
  expect(await f.automations.list()).toHaveLength(2);
  await f.reopen();
  expect((await f.terminal(parent.id, runId)).status).toBe("succeeded");
  expect(await f.automations.list()).toHaveLength(2);
  expect(f.calls).toHaveLength(1);
});

it("retains admitted work and history after removal and can still stop it by ID", async () => {
  const f = await fixture();
  const automation = await f.create({ script: 'await tools.automation_probe({mode:"hold"});' });
  f.advance(60_000);
  const runId = await f.latestRunId(automation.id);
  await vi.waitFor(() => expect(f.calls).toHaveLength(1), WAIT);
  await f.automations.remove(automation.id);
  expect(f.aborted).toBe(0);
  expect(await f.automations.list()).toEqual([]);
  expect(await f.automations.stop(automation.id)).toEqual({ stopped: true });
  expect((await f.terminal(automation.id, runId)).status).toBe("cancelled");
  expect(await f.automations.stop(automation.id)).toEqual({ stopped: false });
});

it("stops a pre-agent script without cancelling existing work in its selected Session", async () => {
  const f = await fixture();
  const session = await f.pi.createConversation({ ownership: { kind: "ownerless" } }, BG);
  await session.configure({ extensions: { add: [f.program] } }, BG);
  const manual = await session.commit(
    (tx) =>
      tx.createTask(
        ProgramTask,
        { code: 'await tools.automation_probe({mode:"hold"});' },
        { ownership: { kind: "conversation" }, conversationId: session.id },
      ),
    BG,
  );
  f.pi.resume();
  await vi.waitFor(() => expect(f.calls).toHaveLength(1), WAIT);
  const automation = await f.create({
    execution: { kind: "existing_session", sessionId: String(session.id) },
    prompt: "This input must never be submitted.",
    script: 'await tools.automation_probe({mode:"hold"});return {runAgent:true};',
  });
  f.advance(60_000);
  const runId = await f.latestRunId(automation.id);
  await vi.waitFor(() => expect(f.calls).toHaveLength(2), WAIT);
  await f.automations.stop(automation.id);
  expect((await f.terminal(automation.id, runId)).status).toBe("cancelled");
  expect(f.aborted).toBe(1);
  f.releases[0]();
  await vi.waitFor(
    async () => expect((await f.pi.getTask(manual, BG))?.state.outcome?.status).toBe("completed"),
    WAIT,
  );
});
