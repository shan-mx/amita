import { createAgent } from "./helpers";
import { COMPANION_PROTOCOL } from "../src/shared/companion";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { env, SELF, runInDurableObject } from "cloudflare:test";
import { codemodeToolCall, owner, WAIT, modelFixture } from "./helpers";
import type { Env } from "../src/env";
import { LiveDoc, type ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { withCancel } from "@earendil-works/chord/context";
import { RemoteExecutionEnv } from "../src/computer/remote-env";
import { CONFIG } from "../src/shared/config";
afterEach(() => vi.restoreAllMocks());
const FIXTURE_CWD = "/fixture";

async function pair() {
  const session = owner();
  await session.login();
  const current = (await session.client.computer.status()).computers;
  for (const device of current) await session.client.computer.revoke({ deviceId: device.id });
  const registration = await session.client.computer.registration();
  const response = await SELF.fetch("https://app.test/api/companion/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: registration.code, name: "Acceptance Mac" }),
  });
  expect(response.status).toBe(200);
  const device = await response.json<{ deviceId: string; credential: string }>();
  const slug = `acceptance-mac-${crypto.randomUUID().slice(0, 8)}`;
  await session.client.computer.confirm({ deviceId: device.deviceId, slug });
  return { session, registration, device, slug };
}
async function connect(credential: string) {
  const response = await SELF.fetch("https://app.test/api/companion/connect", {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${credential}` },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.accept();
  const messages: Record<string, any>[] = [];
  ws.addEventListener("message", (event) => {
    if (event.data === "pong") return;
    messages.push(JSON.parse(String(event.data)));
  });
  ws.send(
    JSON.stringify({
      type: "hello",
      protocol: COMPANION_PROTOCOL,
      name: "Acceptance Mac",
      cwd: FIXTURE_CWD,
      home: FIXTURE_CWD,
      os: "darwin",
    }),
  );
  await vi.waitFor(() => expect(messages.some((item) => item.type === "ready")).toBe(true), WAIT);
  return { ws, messages };
}
const operation = (id: string) => ({
  id,
  method: "exec",
  params: { command: "printf acceptance" },
  deadline: Date.now() + 10000,
});
const frames = async (stream: ReadableStream<Uint8Array>) =>
  (await new Response(stream).text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

it("rejects a mismatched Companion protocol before the device is ready", async () => {
  const { device } = await pair();
  const response = await SELF.fetch("https://app.test/api/companion/connect", {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${device.credential}` },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.accept();
  try {
    const first = new Promise<string | number>((resolve) => {
      ws.addEventListener("message", ({ data }) => resolve(JSON.parse(String(data)).type));
      ws.addEventListener("close", ({ code }) => resolve(code));
    });
    ws.send(
      JSON.stringify({
        type: "hello",
        protocol: COMPANION_PROTOCOL + 1,
        name: "Mismatched Companion",
        cwd: FIXTURE_CWD,
        home: FIXTURE_CWD,
        os: "darwin",
      }),
    );
    expect(await first).toBe(1003);
  } finally {
    ws.close();
  }
});

it.each(["readerRead", "readerScanLines"])(
  "ends $0 on disconnect without replaying it",
  async (method) => {
    const { device } = await pair();
    const initial = await connect(device.credential);
    const computer = (env as unknown as Env).COMPUTERS.getByName(device.deviceId);
    const request = {
      ...operation("fixture:interrupted-read"),
      method,
      params:
        method === "readerRead"
          ? { handle: "reader", offset: 0, length: 64 }
          : { handle: "reader", startLine: 0 },
    };
    const result = frames(await computer.open(request));
    await vi.waitFor(
      () =>
        expect(initial.messages).toContainEqual(
          expect.objectContaining({ type: "execute", id: request.id }),
        ),
      WAIT,
    );
    initial.ws.close();
    expect((await result).at(-1)).toMatchObject({
      result: { ok: false, error: { code: "computer_unavailable" } },
    });

    const reconnected = await connect(device.credential);
    try {
      expect(reconnected.messages.some((frame) => frame.id === request.id)).toBe(false);
    } finally {
      reconnected.ws.close();
    }
  },
);

async function pendingScan() {
  const { device, slug } = await pair();
  const connection = await connect(device.credential);
  connection.ws.addEventListener("message", ({ data }) => {
    if (data === "pong") return;
    const frame = JSON.parse(String(data));
    if (frame.type !== "execute") return;
    if (frame.method === "openBinaryReader" || frame.method === "readerClose")
      connection.ws.send(
        JSON.stringify({
          type: "result",
          id: frame.id,
          seq: 1,
          result: {
            ok: true,
            value: frame.method === "openBinaryReader" ? "fixture-reader" : null,
          },
        }),
      );
  });
  const remote = new RemoteExecutionEnv(
    device.deviceId,
    slug,
    FIXTURE_CWD,
    (env as unknown as Env).COMPUTERS.getByName(device.deviceId),
    undefined,
  );
  const opened = await remote.openBinaryReader("/fixture/note.txt", undefined, BG);
  if (!opened.ok) throw opened.error;
  return { ...connection, remote, reader: opened.value };
}

it("lets a scan finish beyond the ordinary file request deadline", async () => {
  const { ws, messages, remote, reader } = await pendingScan();
  const heartbeat = setInterval(() => ws.send("ping"), 5_000);
  try {
    const result = reader.scanLines({ startLine: 0 }, BG);
    await vi.waitFor(
      () => expect(messages.some((frame) => frame.method === "readerScanLines")).toBe(true),
      WAIT,
    );
    const request = messages.find((frame) => frame.method === "readerScanLines")!;
    await new Promise((resolve) => setTimeout(resolve, CONFIG.computerFileDeadlineMs + 1_000));
    const value = {
      newlines: 0,
      start: 0,
      end: 5,
      firstLineEnd: 5,
      lastLineStart: 0,
      selectedBytes: 5,
      firstLineBytes: 5,
    };
    ws.send(
      JSON.stringify({ type: "result", id: request.id, seq: 1, result: { ok: true, value } }),
    );
    expect(await result).toEqual({ ok: true, value });
  } finally {
    clearInterval(heartbeat);
    await remote.cleanup(BG);
    ws.close();
  }
}, 45_000);

it("cancels an unresponsive scan while the connection stays online", async () => {
  const { ws, messages, remote, reader } = await pendingScan();
  const { context, cancel } = withCancel(BG);
  try {
    const result = reader.scanLines({ startLine: 0 }, context);
    await vi.waitFor(
      () => expect(messages.some((frame) => frame.method === "readerScanLines")).toBe(true),
      WAIT,
    );
    const request = messages.find((frame) => frame.method === "readerScanLines")!;
    cancel();
    expect(await result).toMatchObject({ ok: false, error: { code: "aborted" } });
    await vi.waitFor(
      () => expect(messages).toContainEqual({ type: "cancel", id: request.id, reason: "aborted" }),
      WAIT,
    );
  } finally {
    cancel();
    await remote.cleanup(BG);
    ws.close();
  }
});

it("resumes an offered operation without resending execute and accepts explicit uncertainty", async () => {
  const { device } = await pair();
  const initial = await connect(device.credential);
  const bindings = env as unknown as Env;
  const computer = bindings.COMPUTERS.get(bindings.COMPUTERS.idFromName(device.deviceId));
  const request = operation("fixture:uncertain");
  const result = frames(await computer.open(request));
  await vi.waitFor(
    () => expect(initial.messages.some((item) => item.type === "execute")).toBe(true),
    WAIT,
  );
  initial.ws.close();
  const reconnected = await connect(device.credential);
  await vi.waitFor(
    () =>
      expect(
        reconnected.messages.some((item) => item.type === "resume" && item.id === request.id),
      ).toBe(true),
    WAIT,
  );
  expect(reconnected.messages.some((item) => item.type === "execute")).toBe(false);
  reconnected.ws.send(
    JSON.stringify({
      type: "result",
      id: request.id,
      seq: 1,
      result: {
        ok: false,
        error: { code: "unknown", message: "Interrupted; outcome unknown. Not rerun." },
      },
    }),
  );
  expect((await result).at(-1)).toMatchObject({
    result: { ok: false, error: { code: "unknown" } },
  });
  reconnected.ws.close();
});

it("reports an offered command as unknown when its deadline passes without a result", async () => {
  const { device } = await pair();
  const { ws, messages } = await connect(device.credential);
  const computer = (env as unknown as Env).COMPUTERS.getByName(device.deviceId);
  const timeout = 1;
  const deadline = Date.now() + timeout * 1000;
  const request = {
    ...operation("fixture:unconfirmed-deadline"),
    params: { command: "sleep 2", timeout },
    deadline,
  };
  try {
    const result = frames(await computer.open(request));
    await vi.waitFor(
      () =>
        expect(messages.some(({ type, id }) => type === "execute" && id === request.id)).toBe(true),
      WAIT,
    );
    expect((await result).at(-1)).toMatchObject({
      result: { ok: false, error: { code: "unknown" } },
    });
  } finally {
    ws.close();
  }
});

it("rejects an offline operation before reconnection and sends a per-operation cancellation", async () => {
  const { device } = await pair();
  const bindings = env as unknown as Env;
  const computer = bindings.COMPUTERS.get(bindings.COMPUTERS.idFromName(device.deviceId));
  const offline = operation("fixture:offline");
  const offlineResult = frames(await computer.open(offline));
  await vi.waitFor(
    async () => {
      const result = await Promise.race([offlineResult, Promise.resolve(null)]);
      expect(result?.at(-1)).toMatchObject({
        result: { ok: false, error: { code: "computer_offline" } },
      });
    },
    { timeout: 500 },
  );
  const { ws, messages } = await connect(device.credential);
  expect(messages.some((item) => item.type === "execute" && item.id === offline.id)).toBe(false);
  const active = operation("fixture:cancel");
  const result = frames(await computer.open(active));
  await vi.waitFor(
    () =>
      expect(messages.some((item) => item.type === "execute" && item.id === active.id)).toBe(true),
    WAIT,
  );
  await computer.cancel(active.id, "aborted");
  expect((await result).at(-1)).toMatchObject({
    result: { ok: false, error: { code: "aborted" } },
  });
  await vi.waitFor(
    () =>
      expect(messages.some((item) => item.type === "cancel" && item.id === active.id)).toBe(true),
    WAIT,
  );
  ws.close();
});

it("settles cancellation while disconnected and delivers it on a live reconnect", async () => {
  const { device } = await pair();
  const initial = await connect(device.credential);
  const computer = (env as unknown as Env).COMPUTERS.getByName(device.deviceId);
  const request = {
    id: "fixture:disconnected-stop",
    method: "exec",
    params: { command: "sleep 60" },
  };
  let result: Awaited<ReturnType<typeof frames>> | undefined;
  const completed = frames(await computer.open(request)).then((value) => {
    result = value;
  });
  try {
    await vi.waitFor(
      () => expect(initial.messages.some((item) => item.type === "execute")).toBe(true),
      WAIT,
    );
    initial.ws.close();
    await vi.waitFor(async () => expect((await computer.status()).online).toBe(false), WAIT);
    await computer.cancel(request.id, "aborted");
    await vi.waitFor(
      () =>
        expect(result?.at(-1)).toMatchObject({ result: { ok: false, error: { code: "aborted" } } }),
      WAIT,
    );
    await completed;
    const reconnected = await connect(device.credential);
    try {
      await vi.waitFor(
        () =>
          expect(reconnected.messages).toContainEqual({
            type: "cancel",
            id: request.id,
            reason: "aborted",
          }),
        WAIT,
      );
      expect(
        reconnected.messages.some((item) => item.type === "resume" || item.type === "execute"),
      ).toBe(false);
    } finally {
      reconnected.ws.close();
    }
  } finally {
    await computer.revoke();
  }
});

it("runs Bash in the requested remote directory and returns stdout and stderr", async () => {
  const { session, device, slug } = await pair();
  modelFixture((body) =>
    body.messages.some((message) => message.role === "tool")
      ? { text: "NATIVE_REMOTE_DONE" }
      : {
          tool: codemodeToolCall("bash", {
            cwd: FIXTURE_CWD,
            computer: slug,
            command: "printf native-bridge",
          }),
        },
  );
  const { ws, messages } = await connect(device.credential);
  const created = await createAgent(session.client, { name: "Native remote tool", persona: "" });
  const target = { agentId: created.agent.id, sessionId: created.sessionId };
  await session.client.sessions.submit({
    ...target,
    text: "Run the command.",
    operationId: crypto.randomUUID(),
  });
  await vi.waitFor(
    () => expect(messages.some((message) => message.type === "execute")).toBe(true),
    WAIT,
  );
  const request = messages.find((message) => message.type === "execute")!;
  expect(request).toMatchObject({
    method: "exec",
    params: {
      command: "printf native-bridge",
      cwd: FIXTURE_CWD,
      inheritEnv: true,
      spill: { afterBytes: 51200, afterLines: 2000 },
      window: {
        maxBytes: 51200,
        maxLines: 2000,
        minIntervalMs: 100,
        bytesPerSecond: expect.any(Number),
      },
    },
  });
  ws.send(
    JSON.stringify({
      type: "output",
      id: request.id,
      seq: 1,
      stream: "stdout",
      snapshot: true,
      before: { bytes: 0, newlines: 0, endsWithNewline: false },
      text: "native-bridge\n",
    }),
  );
  ws.send(
    JSON.stringify({
      type: "output",
      id: request.id,
      seq: 2,
      stream: "stderr",
      snapshot: true,
      before: { bytes: 0, newlines: 0, endsWithNewline: false },
      text: "native-bridge\nstderr-visible\n",
    }),
  );
  ws.send(
    JSON.stringify({
      type: "result",
      id: request.id,
      seq: 3,
      result: { ok: true, value: { exitCode: 0 } },
    }),
  );
  await vi.waitFor(
    async () =>
      expect(JSON.stringify((await session.client.sessions.history(target)).entries)).toContain(
        "NATIVE_REMOTE_DONE",
      ),
    WAIT,
  );
  const result = (await session.client.sessions.history(target)).entries
    .flatMap((entry) => entry.model ?? [])
    .find((message) => message.role === "toolResult" && message.toolName === "codemode");
  expect(result).toMatchObject({
    isError: false,
    content: expect.arrayContaining([
      { type: "text", text: expect.stringContaining("native-bridge\\nstderr-visible") },
    ]),
  });
  ws.close();
});

it("keeps the final UTF-8 output when cumulative Bash output is truncated", async () => {
  const { session, device, slug } = await pair();
  modelFixture((body) =>
    body.messages.some((message) => message.role === "tool")
      ? { text: "SNAPSHOT_NATIVE_DONE" }
      : {
          tool: codemodeToolCall("bash", {
            cwd: FIXTURE_CWD,
            computer: slug,
            command: "large-output",
          }),
        },
  );
  const { ws, messages } = await connect(device.credential);
  const created = await createAgent(session.client, { name: "Windowed output", persona: "" });
  const target = { agentId: created.agent.id, sessionId: created.sessionId };
  await session.client.sessions.submit({
    ...target,
    text: "Run it.",
    operationId: crypto.randomUUID(),
  });
  await vi.waitFor(() => expect(messages.some((item) => item.type === "execute")).toBe(true), WAIT);
  const request = messages.find((item) => item.type === "execute")!;
  const text = "x".repeat(51_204) + "\n中文-final";
  ws.send(
    JSON.stringify({
      type: "output",
      id: request.id,
      seq: 7,
      snapshot: true,
      before: { bytes: 60_000, newlines: 200, endsWithNewline: true },
      stream: "stdout",
      text,
    }),
  );
  ws.send(
    JSON.stringify({
      type: "result",
      id: request.id,
      seq: 8,
      result: { ok: true, value: { exitCode: 0 } },
    }),
  );
  await vi.waitFor(
    async () =>
      expect(JSON.stringify((await session.client.sessions.history(target)).entries)).toContain(
        "SNAPSHOT_NATIVE_DONE",
      ),
    WAIT,
  );
  const entries = (await session.client.sessions.history(target)).entries;
  const result = entries
    .flatMap((entry) => entry.model ?? [])
    .find((message) => message.role === "toolResult" && message.toolName === "codemode");
  expect(result).toMatchObject({ isError: false });
  expect(JSON.stringify(result)).toContain("中文-final");
  expect(JSON.stringify(result)).toContain("truncated");
  ws.close();
});

it.each([
  { situation: "reconnecting to a Companion", reconnect: true },
  { situation: "receiving a backward output snapshot", reconnect: false },
])("reports uncertainty after $situation without duplicating output", async ({ reconnect }) => {
  const { session, device, slug } = await pair();
  modelFixture((body) =>
    body.messages.some((message) => message.role === "tool")
      ? { text: "RECONNECT_COMPLETE" }
      : {
          tool: {
            name: "bash",
            arguments: { cwd: FIXTURE_CWD, computer: slug, command: "reconnect-fixture" },
          },
        },
  );
  const initial = await connect(device.credential);
  const created = await createAgent(session.client, { name: "Protocol reconnect", persona: "" });
  const target = { agentId: created.agent.id, sessionId: created.sessionId };
  await session.client.sessions.submit({
    ...target,
    text: "Run the tool.",
    operationId: crypto.randomUUID(),
  });
  await vi.waitFor(
    () => expect(initial.messages.some((item) => item.type === "execute")).toBe(true),
    WAIT,
  );
  const request = initial.messages.find((item) => item.type === "execute")!;
  const prefix = "前🙂\n";
  initial.ws.send(
    JSON.stringify({
      type: "output",
      id: request.id,
      seq: 1,
      stream: "stdout",
      text: prefix,
      snapshot: true,
      before: { bytes: 0, newlines: 0, endsWithNewline: false },
    }),
  );
  const bindings = env as unknown as Env;
  const agent = bindings.AGENTS.get(bindings.AGENTS.idFromName(target.agentId));
  await vi.waitFor(async () => {
    const output = await runInDurableObject(agent, async (instance) => {
      const pi = await instance.harness.pi();
      const live = await pi.snapshot(LiveDoc, Number(target.sessionId) as ConversationId, BG);
      return live?.tools?.find((tool) => tool.name === "bash")?.output;
    });
    expect(output).toBe(prefix);
  }, WAIT);
  if (reconnect) initial.ws.close();
  const { ws } = reconnect ? await connect(device.credential) : initial;
  ws.send(
    JSON.stringify({
      type: "output",
      id: request.id,
      seq: 2,
      snapshot: true,
      before: { bytes: 0, newlines: 0, endsWithNewline: false },
      stream: "stdout",
      text: reconnect ? prefix + "后\n" : "后\n",
    }),
  );
  if (reconnect)
    ws.send(
      JSON.stringify({
        type: "result",
        id: request.id,
        seq: 3,
        result: {
          ok: false,
          error: { code: "unknown", message: "Execution was interrupted while disconnected." },
        },
      }),
    );
  await vi.waitFor(
    async () =>
      expect(JSON.stringify((await session.client.sessions.history(target)).entries)).toContain(
        "RECONNECT_COMPLETE",
      ),
    WAIT,
  );
  const result = (await session.client.sessions.history(target)).entries
    .flatMap((entry) => entry.model ?? [])
    .find((message) => message.role === "toolResult" && message.toolName === "bash");
  expect(result).toMatchObject({ isError: true });
  const text = JSON.stringify(result);
  expect(text.split("前🙂")).toHaveLength(2);
  expect(text).not.toContain("[unknown]");
  expect(text).toMatch(/interrupted|without a confirmed result/);
  expect(text.includes("后")).toBe(reconnect);
  ws.close();
});
