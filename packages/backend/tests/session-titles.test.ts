import { createAgent } from "./helpers";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { SELF, env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { applyImmutable } from "@earendil-works/chord/delta";
import { SessionMetadata } from "../src/agent/session-metadata";
import type { ConversationView, TaskId } from "@earendil-works/pi-durable";
import type { Env } from "../src/env";
import type { StreamPacket } from "../src/shared/types";
import { owner, WAIT } from "./helpers";

type RequestBody = {
  messages: { role: string; content: string }[];
  thinking?: { type: string };
};

afterEach(() => vi.restoreAllMocks());

function fixture(title: (request: RequestBody) => Promise<string> = async () => "修复登录会话") {
  const original = globalThis.fetch;
  const titles: RequestBody[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (resource, options) => {
    const request = new Request(resource, options);
    if (!request.url.startsWith("https://api.deepseek.com/")) return original(resource, options);
    const body = (await request.json()) as RequestBody;
    const naming = body.thinking?.type === "disabled";
    if (naming) titles.push(body);
    const text = naming ? await title(body) : "我会检查登录流程。";
    const chunk = (delta: unknown, finish_reason: string | null = null) =>
      `data: ${JSON.stringify({ id: "title-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(
      chunk({ role: "assistant", content: text }) + chunk({}, "stop") + "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  return { titles };
}

async function session() {
  const current = owner();
  await current.login();
  const created = await createAgent(current.client, {
    name: "Title fixture",
    persona: "PRIVATE_PERSONA_MARKER",
  });
  const target = { agentId: created.agent.id, sessionId: created.sessionId };
  return {
    client: current.client,
    cookie: current.cookie,
    target,
    submit: (text = "帮我修复登录后会话丢失的问题", operationId = crypto.randomUUID()) =>
      current.client.sessions.submit({ ...target, text, operationId }),
    title: async () => (await current.client.sessions.list(target))[0].title,
    stub: (env as unknown as Env).AGENTS.getByName(target.agentId),
  };
}

async function namingSettled(current: Awaited<ReturnType<typeof session>>) {
  await vi.waitFor(async () => {
    await runInDurableObject(current.stub, async (instance) => {
      const pi = await instance.harness.pi();
      const conversation = await instance.harness.conversation(current.target.sessionId);
      const metadata = await pi.snapshot(SessionMetadata, conversation.id, BG);
      expect(metadata?.titleTaskId).toBeTypeOf("number");
      expect((await pi.getTask(metadata!.titleTaskId! as TaskId, BG))?.state.status).toBe(
        "terminal",
      );
    });
  }, WAIT);
}

it("names once from bounded user text without sending persona or memory and persists after eviction", async () => {
  const model = fixture();
  const current = await session();
  await current.client.agents.saveMemory({
    agentId: current.target.agentId,
    memory: "PRIVATE_MEMORY_MARKER",
  });
  const operationId = crypto.randomUUID();
  const input = `帮我修复登录会话 ${"详细描述 ".repeat(2000)}`;
  await current.submit(input, operationId);
  await vi.waitFor(async () => expect(await current.title()).toBe("修复登录会话"), WAIT);
  await current.submit(input, operationId);
  await current.submit("接下来检查退出登录");
  expect(model.titles).toHaveLength(1);
  const prompt = model.titles[0].messages.find((message) => message.role === "user");
  expect(prompt?.content.length).toBeLessThanOrEqual(4000);
  expect(JSON.stringify(model.titles)).not.toContain("PRIVATE_");
  await vi.waitFor(
    async () => expect((await current.client.sessions.list(current.target))[0].busy).toBe(false),
    WAIT,
  );
  await evictDurableObject(current.stub);
  expect(await current.title()).toBe("修复登录会话");
  expect(model.titles).toHaveLength(1);
});

it("keeps chatting while naming is pending and pushes a title update after the chat ends", async () => {
  let release!: (title: string) => void;
  const pending = new Promise<string>((resolve) => {
    release = resolve;
  });
  const model = fixture(() => pending);
  const current = await session();
  const origin = "https://amita.test";
  const response = await SELF.fetch(
    `${origin}/api/events/${current.target.agentId}/${current.target.sessionId}`,
    { headers: { Cookie: current.cookie(), Origin: origin, Upgrade: "websocket" } },
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  let view: ConversationView | undefined;
  let titleChanged = false;
  socket.addEventListener("message", ({ data }) => {
    const packet = JSON.parse(String(data)) as StreamPacket;
    if (packet.type === "snapshot") view = packet.view;
    if (packet.type === "delta") view = applyImmutable(view, packet.ops);
    if (packet.type === "session_changed") titleChanged = true;
  });
  socket.accept();
  try {
    await vi.waitFor(() => expect(view).toBeDefined(), WAIT);
    await current.submit();
    await vi.waitFor(() => expect(model.titles).toHaveLength(1), WAIT);
    await vi.waitFor(async () => {
      const history = await current.client.sessions.history(current.target);
      expect(JSON.stringify(history.entries)).toContain("我会检查登录流程。");
      expect((await current.client.sessions.list(current.target))[0].busy).toBe(false);
    }, WAIT);
    expect(await current.title()).toBe("帮我修复登录后会话丢失的问题");
    release("修复登录会话");
    await namingSettled(current);
    await vi.waitFor(() => {
      expect(titleChanged).toBe(true);
      expect(JSON.stringify(view?.entries)).toContain("我会检查登录流程。");
    }, WAIT);
    expect(await current.title()).toBe("修复登录会话");
    const history = await current.client.sessions.history(current.target);
    expect(JSON.stringify(history.entries)).not.toContain("修复登录会话");
  } finally {
    release("修复登录会话");
    socket.close();
  }
});

it("preserves manual titles set before submission or while a generation is in flight", async () => {
  let release!: (title: string) => void;
  const pending = new Promise<string>((resolve) => {
    release = resolve;
  });
  const model = fixture(() => pending);
  const current = await session();
  try {
    await current.submit();
    await vi.waitFor(() => expect(model.titles).toHaveLength(1), WAIT);
    await current.client.sessions.update({ ...current.target, title: "My chosen title" });
    release("修复登录会话");
    await namingSettled(current);
    await vi.waitFor(async () => expect(await current.title()).toBe("My chosen title"), WAIT);
    const next = await current.client.sessions.create({ agentId: current.target.agentId });
    const target = { agentId: current.target.agentId, sessionId: next.id };
    await current.client.sessions.update({ ...target, title: "Named before sending" });
    await current.client.sessions.submit({
      ...target,
      text: "Another topic",
      operationId: crypto.randomUUID(),
    });
    await vi.waitFor(async () => {
      expect(JSON.stringify((await current.client.sessions.history(target)).entries)).toContain(
        "我会检查登录流程。",
      );
    }, WAIT);
    expect(model.titles).toHaveLength(1);
  } finally {
    release("修复登录会话");
  }
});

it("keeps the input fallback after a failed generation without retrying on later messages", async () => {
  const model = fixture(async () => {
    throw new Error("Naming provider unavailable");
  });
  const current = await session();
  await current.submit();
  await vi.waitFor(async () => {
    expect(
      JSON.stringify((await current.client.sessions.history(current.target)).entries),
    ).toContain("我会检查登录流程。");
    expect(model.titles).toHaveLength(1);
  }, WAIT);
  expect(await current.title()).toBe("帮我修复登录后会话丢失的问题");
  await namingSettled(current);
  await current.submit("继续排查");
  await vi.waitFor(
    async () => expect((await current.client.sessions.list(current.target))[0].busy).toBe(false),
    WAIT,
  );
  expect(model.titles).toHaveLength(1);
  expect(await current.title()).toBe("帮我修复登录后会话丢失的问题");
});
