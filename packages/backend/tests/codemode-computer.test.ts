import { createAgent } from "./helpers";
import { COMPANION_PROTOCOL } from "../src/shared/companion";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { env, SELF, runInDurableObject } from "cloudflare:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { LiveDoc, NestedCallDoc, type ConversationId } from "@earendil-works/pi-durable";
import type { Env } from "../src/env";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { RemoteRequest } from "../src/shared/companion";
import { automationTriggerSoon, codemodeToolCall, modelFixture, owner, WAIT } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const SPILL_PATH = "/fixture/spill/output.log";

const HELLO = {
  type: "hello",
  protocol: COMPANION_PROTOCOL,
  name: "Nested fixture Mac",
  cwd: "/fixture",
  home: "/fixture",
  os: "darwin",
};

async function registeredComputer() {
  const account = owner();
  await account.login();
  const current = (await account.client.computer.status()).computers;
  for (const device of current) await account.client.computer.revoke({ deviceId: device.id });
  const registration = await account.client.computer.registration();
  const paired = await SELF.fetch("https://app.test/api/companion/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: registration.code, name: HELLO.name }),
  });
  expect(paired.status).toBe(200);
  const device = await paired.json<{ deviceId: string; credential: string }>();
  const slug = `nested-fixture-mac-${crypto.randomUUID().slice(0, 8)}`;
  await account.client.computer.confirm({ deviceId: device.deviceId, slug });
  return { account, device, slug };
}

it("cancels one nested command without stopping its sibling on the same Computer", async () => {
  const { account, device, slug } = await registeredComputer();
  modelFixture(({ messages }) =>
    messages.some((message) => message.role === "tool")
      ? { text: "NESTED_COMPUTER_DONE" }
      : {
          tool: {
            name: "codemode",
            arguments: {
              code: `
    const results = await Promise.allSettled([
      tools.bash({ cwd:${JSON.stringify(HELLO.cwd)}, computer: ${JSON.stringify(slug)}, command: "hold-first" }),
      tools.bash({ cwd:${JSON.stringify(HELLO.cwd)}, computer: ${JSON.stringify(slug)}, command: "keep-second" }),
    ]);
    return { statuses: results.map((r) => r.status), exitCode: results[1].value.exitCode,
      output: results[1].value.output, fullOutputPath: results[1].value.fullOutputPath };
  `,
            },
          },
        },
  );
  const requests: RemoteRequest[] = [];
  const cancelled: string[] = [];
  let ready = false;
  const connection = await SELF.fetch("https://app.test/api/companion/connect", {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${device.credential}` },
  });
  const socket = connection.webSocket!;
  socket.accept();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.type === "execute") requests.push(message);
    if (message.type === "cancel") cancelled.push(message.id);
    if (message.type === "ready") ready = true;
  });
  socket.send(JSON.stringify(HELLO));
  try {
    await vi.waitFor(() => expect(ready).toBe(true), WAIT);
    const created = await createAgent(account.client, { name: "Nested Computer", persona: "" });
    const target = { agentId: created.agent.id, sessionId: created.sessionId };
    const agent = (env as unknown as Env).AGENTS.getByName(target.agentId);
    await account.client.sessions.submit({
      ...target,
      text: "Run both commands.",
      operationId: crypto.randomUUID(),
    });
    await vi.waitFor(() => expect(requests).toHaveLength(2), WAIT);
    const first = requests.find((request) => request.params.command === "hold-first")!;
    const second = requests.find((request) => request.params.command === "keep-second")!;
    await runInDurableObject(agent, async (instance) => {
      const pi = await instance.harness.pi();
      const live = await pi.snapshot(LiveDoc, Number(target.sessionId) as ConversationId, BG);
      const children = live?.nestedTools ?? [];
      const child = children.find((item) => item.arguments.command === "hold-first")!;
      await pi.abortTask(child.taskId, BG);
    });
    await vi.waitFor(() => expect(cancelled).toContain(first.id), WAIT);
    expect(cancelled).not.toContain(second.id);
    socket.send(
      JSON.stringify({
        type: "output",
        id: second.id,
        seq: 1,
        snapshot: true,
        before: { bytes: 0, newlines: 0, endsWithNewline: false },
        stream: "stdout",
        text: "nonzero-output\n",
      }),
    );
    socket.send(
      JSON.stringify({
        type: "result",
        id: second.id,
        seq: 2,
        result: { ok: true, value: { exitCode: 7, spillPath: SPILL_PATH } },
      }),
    );
    await vi.waitFor(async () => {
      const history = await account.client.sessions.history(target);
      const result = history.entries
        .flatMap((entry) => entry.model ?? [])
        .find(
          (message): message is ToolResultMessage =>
            message.role === "toolResult" && message.toolName === "codemode",
        );
      expect(result).toMatchObject({ isError: false });
      const text = result?.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      expect(text).toContain('"statuses":["rejected","fulfilled"]');
      expect(text).toContain('"exitCode":7');
      expect(text).toContain("nonzero-output");
      expect(text).toContain(`"fullOutputPath":"/computers/${slug}/fs${SPILL_PATH}"`);
      expect(JSON.stringify(history.entries)).toContain("NESTED_COMPUTER_DONE");
    }, WAIT);
    expect(requests).toHaveLength(2);
  } finally {
    socket.close();
  }
});

it.each([
  { code: "timeout", message: "Command exceeded its deadline.", started: true },
  {
    code: "expired_before_start",
    message: "operation expired before it could start",
    started: false,
  },
])("preserves a confirmed Bash $code result", async ({ code, message, started }) => {
  const { account, device, slug } = await registeredComputer();
  const connection = await SELF.fetch("https://app.test/api/companion/connect", {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${device.credential}` },
  });
  const ws = connection.webSocket!;
  ws.accept();
  const requests: RemoteRequest[] = [];
  let ready = false;
  ws.addEventListener("message", ({ data }) => {
    const frame = JSON.parse(String(data));
    if (frame.type === "ready") ready = true;
    if (frame.type === "execute") requests.push(frame);
  });
  ws.send(JSON.stringify(HELLO));
  try {
    await vi.waitFor(() => expect(ready).toBe(true), WAIT);
    modelFixture(({ messages }) =>
      messages.some(({ role }) => role === "tool")
        ? { text: "TIMEOUT_DONE" }
        : {
            tool: codemodeToolCall("bash", {
              computer: slug,
              cwd: HELLO.cwd,
              command: "sleep 400",
              timeout: 1,
            }),
          },
    );
    const { agent, sessionId } = await createAgent(account.client, {
      name: "Timeout",
      persona: "",
    });
    const target = { agentId: agent.id, sessionId };
    await account.client.sessions.submit({
      ...target,
      text: "Run a command.",
      operationId: crypto.randomUUID(),
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1), WAIT);
    const [request] = requests;
    const timeoutSeconds = 1;
    expect(request.params.timeout).toBe(timeoutSeconds);

    ws.send(
      JSON.stringify({
        type: "result",
        id: request.id,
        seq: 1,
        result: {
          ok: false,
          error: { code, message, ...(started ? { spillPath: SPILL_PATH } : {}) },
        },
      }),
    );
    await vi.waitFor(async () => {
      const entries = (await account.client.sessions.history(target)).entries;
      const result = entries
        .flatMap((entry) => entry.model ?? [])
        .find((item) => item.role === "toolResult" && item.toolName === "codemode");
      expect(result).toMatchObject({ isError: true });
      const text = JSON.stringify(result);
      if (!started) expect(text).toContain(message);
      expect(text.includes(`Command timed out after ${timeoutSeconds} seconds`)).toBe(started);
    }, WAIT);
  } finally {
    ws.close();
  }
});

it("bounds an offline nested command and never dispatches it after reconnect", async () => {
  const { account, device, slug } = await registeredComputer();
  modelFixture(({ messages }) =>
    messages.some((message) => message.role === "tool")
      ? { text: "OFFLINE_NESTED_DONE" }
      : {
          tool: {
            name: "codemode",
            arguments: {
              code: `return await Promise.allSettled([tools.bash({cwd:${JSON.stringify(HELLO.cwd)},computer:${JSON.stringify(slug)},command:"expired-never-run",timeout:1})]);`,
            },
          },
        },
  );
  const created = await createAgent(account.client, {
    name: "Offline nested command",
    persona: "",
  });
  const target = { agentId: created.agent.id, sessionId: created.sessionId };
  await account.client.sessions.submit({
    ...target,
    text: "Run offline with a one-second limit.",
    operationId: crypto.randomUUID(),
  });
  await vi.waitFor(async () => {
    const history = await account.client.sessions.history(target);
    const result = history.entries
      .flatMap((entry) => entry.model ?? [])
      .find(
        (message): message is ToolResultMessage =>
          message.role === "toolResult" && message.toolName === "codemode",
      );
    expect(result).toMatchObject({
      isError: false,
      details: {
        calls: [
          {
            name: "bash",
            status: "error",
            error: expect.stringContaining("The Computer is offline. The operation did not run."),
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain("Command timed out");
    expect(JSON.stringify(history.entries)).toContain("OFFLINE_NESTED_DONE");
  }, WAIT);
  const connected = await SELF.fetch("https://app.test/api/companion/connect", {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${device.credential}` },
  });
  const ws = connected.webSocket!;
  ws.accept();
  const executed: unknown[] = [];
  let ready = false;
  ws.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.type === "execute") executed.push(message);
    if (message.type === "ready") ready = true;
  });
  ws.send(JSON.stringify(HELLO));
  try {
    await vi.waitFor(() => expect(ready).toBe(true), WAIT);
    const computer = (env as unknown as Env).COMPUTERS.getByName(device.deviceId);
    expect((await computer.status()).online).toBe(true);
    expect(executed).toEqual([]);
  } finally {
    ws.close();
  }
});

it("reuses a committed Bash result after reopening Pi and does not dispatch an unconfirmed edit again", async () => {
  const { account, device, slug } = await registeredComputer();
  const path = `/computers/${slug}/fs/fixture/edited.txt`;
  modelFixture(({ messages }) =>
    messages.some((message) => message.role === "tool")
      ? { text: "REOPEN_DONE" }
      : {
          tool: {
            name: "codemode",
            arguments: {
              code: `
                const first = await tools.bash({ cwd:${JSON.stringify(HELLO.cwd)}, computer: ${JSON.stringify(slug)}, command: "committed-side-effect" });
                try { await tools.fs_edit({path:${JSON.stringify(path)}, edits:[{oldText:"original",newText:"edited"}]}); }
                catch (error) { return { first: first.output, interruption: String(error) }; }
                throw new Error("The edit result was never confirmed");
              `,
            },
          },
        },
  );
  const connected = await SELF.fetch("https://app.test/api/companion/connect", {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${device.credential}` },
  });
  const ws = connected.webSocket!;
  ws.accept();
  const requests: RemoteRequest[] = [];
  let file = "original";
  let ready = false;
  ws.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.type === "ready") ready = true;
    if (message.type !== "execute") return;
    requests.push(message);
    if (message.params.command === "committed-side-effect") {
      ws.send(
        JSON.stringify({
          type: "output",
          id: message.id,
          seq: 1,
          snapshot: true,
          before: { bytes: 0, newlines: 0, endsWithNewline: false },
          stream: "stdout",
          text: "committed-once",
        }),
      );
      ws.send(
        JSON.stringify({
          type: "result",
          id: message.id,
          seq: 2,
          result: { ok: true, value: { exitCode: 0 } },
        }),
      );
      return;
    }
    if (message.method === "writeFile") {
      file = message.params.content;
      // The file changed, but its result never reached Pi.
      return;
    }
    const values: Record<string, unknown> = {
      absolutePath: "/fixture/edited.txt",
      fileInfo: { kind: "file" },
      readTextFile: btoa(file),
    };
    const value = values[message.method];
    ws.send(
      JSON.stringify({ type: "result", id: message.id, seq: 1, result: { ok: true, value } }),
    );
  });
  ws.send(JSON.stringify(HELLO));
  try {
    await vi.waitFor(() => expect(ready).toBe(true), WAIT);
    const created = await createAgent(account.client, {
      name: "Reopen nested calls",
      persona: "",
    });
    const target = { agentId: created.agent.id, sessionId: created.sessionId };
    await account.client.sessions.submit({
      ...target,
      text: "Run the two effects once.",
      operationId: crypto.randomUUID(),
    });
    await vi.waitFor(() => expect(file).toBe("edited"), WAIT);
    const agent = (env as unknown as Env).AGENTS.getByName(target.agentId);
    await runInDurableObject(agent, async (instance) => {
      const pi = await instance.harness.pi();
      const live = await pi.snapshot(LiveDoc, Number(target.sessionId) as ConversationId, BG);
      const parentTask = live!.nestedTools![0].parentTaskId;
      const committed = await pi.snapshot(NestedCallDoc, parentTask, "c1", BG);
      expect(committed?.result).toMatchObject({
        isError: false,
        structuredOutput: { output: "committed-once", exitCode: 0 },
      });
      expect((await pi.snapshot(NestedCallDoc, parentTask, "c2", BG))?.result).toBeUndefined();
      await instance.harness.dispose();
      const reopened = await instance.harness.pi();
      // PiHarness resumes on open; the completed caller retires its native result documents.
      await reopened.waitForTask(parentTask, BG);
      expect(await reopened.snapshot(NestedCallDoc, parentTask, "c1", BG)).toBeUndefined();
    });
    await vi.waitFor(async () => {
      const history = await account.client.sessions.history(target);
      const result = history.entries
        .flatMap((entry) => entry.model ?? [])
        .find(
          (message): message is ToolResultMessage =>
            message.role === "toolResult" && message.toolName === "codemode",
        );
      expect(result).toMatchObject({ isError: false });
      expect(JSON.stringify(result?.content)).toContain("committed-once");
      expect(JSON.stringify(result?.content)).toMatch(/interrupt|unknown/i);
      expect(JSON.stringify(history.entries)).toContain("REOPEN_DONE");
    }, WAIT);
    expect(requests.filter(({ method }) => method === "exec")).toHaveLength(1);
    expect(requests.filter(({ method }) => method === "readTextFile")).toHaveLength(1);
    expect(requests.filter(({ method }) => method === "writeFile")).toHaveLength(1);
    expect(file).toBe("edited");
  } finally {
    ws.close();
  }
});

it("records an automation's unknown Computer result after reconnect without executing it again", async () => {
  const { account, device, slug } = await registeredComputer();
  const model = modelFixture(() => ({ text: "UNEXPECTED_MODEL_REQUEST" }));
  const sockets: WebSocket[] = [];
  const requests: RemoteRequest[] = [];
  const resumed: string[] = [];
  let ready = 0;
  const connect = async () => {
    const response = await SELF.fetch("https://app.test/api/companion/connect", {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${device.credential}` },
    });
    const ws = response.webSocket!;
    sockets.push(ws);
    ws.accept();
    ws.addEventListener("message", ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.type === "ready") ready++;
      if (message.type === "execute") requests.push(message);
      if (message.type === "resume") {
        resumed.push(message.id);
        ws.send(
          JSON.stringify({
            type: "result",
            id: message.id,
            seq: 1,
            result: {
              ok: false,
              error: {
                code: "unknown",
                message: "Companion restarted after accepting the operation.",
              },
            },
          }),
        );
      }
    });
    ws.send(JSON.stringify(HELLO));
    return ws;
  };
  try {
    const first = await connect();
    await vi.waitFor(() => expect(ready).toBe(1), WAIT);
    const agentId = (
      await createAgent(account.client, { name: "Automation unknown outcome", persona: "" })
    ).agent.id;
    const automation = await account.client.automations.create({
      agentId,
      id: crypto.randomUUID(),
      definition: {
        name: "Unknown remote operation",
        timezone: "Asia/Taipei",
        trigger: automationTriggerSoon(),
        enabled: true,
        script: `try {await tools.bash({computer:${JSON.stringify(slug)},cwd:${JSON.stringify(HELLO.cwd)},command:"effect-before-disconnect"});} catch(error) {text(String(error));} return 42;`,
      },
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1), WAIT);
    const operation = requests[0];
    expect(operation.deadline).toBeUndefined();
    expect(operation.params.timeout).toBeUndefined();
    first.close();
    await connect();
    await vi.waitFor(async () => {
      const history = await account.client.automations.history({ agentId, id: automation.id });
      expect(history.runs[0]).toMatchObject({
        status: "succeeded",
        output: expect.stringContaining("Companion restarted after accepting the operation."),
      });
    }, WAIT);
    expect(requests).toHaveLength(1);
    expect(resumed).toEqual([operation.id]);
    expect(model.requests).toEqual([]);
  } finally {
    for (const ws of sockets) ws.close();
  }
});

it("records an offline Automation command as a known non-execution", async () => {
  const { account, slug } = await registeredComputer();
  const agentId = (
    await createAgent(account.client, { name: "Automation offline Computer", persona: "" })
  ).agent.id;
  const automation = await account.client.automations.create({
    agentId,
    id: crypto.randomUUID(),
    definition: {
      name: "Offline Computer",
      timezone: "Asia/Taipei",
      trigger: automationTriggerSoon(),
      enabled: true,
      script: `try { await tools.bash({ computer: ${JSON.stringify(slug)}, cwd: ${JSON.stringify(HELLO.cwd)}, command: "never-run", timeout: 0.5 }); } catch (error) { text(String(error)); }`,
    },
  });
  await vi.waitFor(async () => {
    const history = await account.client.automations.history({ agentId, id: automation.id });
    expect(history.runs[0]).toMatchObject({
      status: "succeeded",
      output: expect.stringContaining("The Computer is offline. The operation did not run."),
    });
  }, WAIT);
});
