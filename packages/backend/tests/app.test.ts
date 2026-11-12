import { createAgent } from "./helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  SELF,
  env,
  runInDurableObject,
  evictDurableObject,
  abortAllDurableObjects,
} from "cloudflare:test";
import { createORPCClient } from "@orpc/client";
import type { RouterClient } from "@orpc/server";
import { RPCLink } from "@orpc/client/fetch";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { ConversationTranscript } from "@earendil-works/pi-durable";
import type { AppRouter } from "../src/http/router";
import type { Env } from "../src/env";
import { digest } from "../src/http/auth";
import { CONFIG } from "../src/shared/config";
import type { StreamPacket } from "../src/shared/types";
import { setupTestProviders } from "./helpers";

const ORIGIN = "https://amita.test";
const NATIVE_WAIT = { timeout: 5_000, interval: 25 };
beforeEach(setupTestProviders);
afterEach(() => vi.restoreAllMocks());
function browser() {
  let cookie = "";
  const ip = crypto.randomUUID();
  const client: RouterClient<AppRouter> = createORPCClient(
    new RPCLink({
      url: `${ORIGIN}/api/rpc`,
      fetch: async (request, init) => {
        const incoming = new Request(request, init);
        const headers = new Headers(incoming.headers);
        headers.set("Origin", ORIGIN);
        headers.set("CF-Connecting-IP", ip);
        if (cookie) headers.set("Cookie", cookie);
        const response = await SELF.fetch(new Request(incoming, { headers }));
        const setCookie = response.headers.get("Set-Cookie");
        if (setCookie) cookie = setCookie.split(";")[0];
        return response;
      },
    }),
  );
  return { client, cookie: () => cookie };
}

async function openChat(cookie: string, agentId: string, sessionId: string, from?: number) {
  const url = new URL(`/api/events/${agentId}/${sessionId}`, ORIGIN);
  if (from !== undefined) url.searchParams.set("from", String(from));
  const response = await SELF.fetch(url, {
    headers: { Cookie: cookie, Origin: ORIGIN, Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const packets: StreamPacket[] = [];
  const closed = new Promise<number>((resolve) =>
    socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
  );
  socket.addEventListener("message", ({ data }) => {
    packets.push(JSON.parse(String(data)));
  });
  socket.accept();
  await vi.waitFor(() => expect(packets[0]?.type).toBe("snapshot"), NATIVE_WAIT);
  return { socket, packets, closed };
}

describe("owner API and native persistence", () => {
  it("limits login requests per IP, including successful logins", async () => {
    const current = browser();
    for (let index = 0; index < 2; index++)
      await expect(current.client.auth.login({ password: "wrong" })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    await current.client.auth.login({ password: "test-owner-password" });
    await expect(
      current.client.auth.login({ password: "test-owner-password" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(await current.client.auth.status()).toMatchObject({ authenticated: true });
    await expect(
      browser().client.auth.login({ password: "test-owner-password" }),
    ).resolves.toMatchObject({ authenticated: true });
  });

  it("enforces auth, Origin, JSON and safe login cookies", async () => {
    const current = browser();
    expect(await current.client.auth.status()).toEqual({ configured: true, authenticated: false });
    await expect(current.client.agents.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(current.client.auth.login({ password: "wrong" })).rejects.toMatchObject({
      message: "Incorrect password.",
    });
    await current.client.auth.login({ password: "test-owner-password" });
    expect(current.cookie()).toMatch(/^amita_owner=/);
    expect(await current.client.auth.status()).toMatchObject({ authenticated: true });
    expect(
      (
        await SELF.fetch(`${ORIGIN}/api/rpc/auth/logout`, {
          method: "POST",
          headers: {
            Origin: "https://other.test",
            "Content-Type": "application/json",
            Cookie: current.cookie(),
          },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await SELF.fetch(`${ORIGIN}/api/rpc/auth/logout`, {
          method: "POST",
          headers: { Origin: ORIGIN, "Content-Type": "text/plain", Cookie: current.cookie() },
          body: "{}",
        })
      ).status,
    ).toBe(415);
    expect(
      (await SELF.fetch(`${ORIGIN}/api/rpc/auth/logout`, { headers: { Cookie: current.cookie() } }))
        .status,
    ).toBe(405);
  });

  it("persists distinct personas and independent native Sessions", async () => {
    const { client } = browser();
    await client.auth.login({ password: "test-owner-password" });
    const first = await createAgent(client, { name: "Writer", persona: "Write clear prose." });
    const second = await createAgent(client, { name: "Reviewer", persona: "Review critically." });
    await client.agents.update({ agentId: first.agent.id, name: "Editor" });
    const previous = await client.agents.persona({ agentId: first.agent.id });
    await client.agents.savePersona({
      agentId: first.agent.id,
      persona: "Edit briefly.",
      expectedVersion: previous.version,
    });
    const agents = await client.agents.list();
    expect(agents.find((agent) => agent.id === first.agent.id)).toMatchObject({
      name: "Editor",
    });
    expect(agents.find((agent) => agent.id === second.agent.id)).toMatchObject({
      name: "Reviewer",
    });
    expect((await client.agents.persona({ agentId: first.agent.id })).persona).toBe(
      "Edit briefly.",
    );
    expect((await client.agents.persona({ agentId: second.agent.id })).persona).toBe(
      "Review critically.",
    );
    const session = await client.sessions.create({ agentId: first.agent.id });
    expect(session.id).not.toBe(first.sessionId);
    expect(await client.sessions.list({ agentId: first.agent.id })).toHaveLength(2);
    expect(await client.sessions.list({ agentId: second.agent.id })).toHaveLength(1);
  });

  it("publishes one Agent when simultaneous creates request the same slug", async () => {
    const { client } = browser();
    await client.auth.login({ password: "test-owner-password" });
    const slug = `shared-${crypto.randomUUID().slice(0, 8)}`;
    const results = await Promise.allSettled([
      createAgent(client, { slug, name: "First candidate", persona: "" }),
      createAgent(client, { slug, name: "Second candidate", persona: "" }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toEqual([
      { status: "rejected", reason: expect.objectContaining({ code: "CONFLICT" }) },
    ]);
    expect((await client.agents.list()).filter((agent) => agent.slug === slug)).toHaveLength(1);
  });

  it("revokes only the current login", async () => {
    const first = browser();
    const second = browser();
    await first.client.auth.login({ password: "test-owner-password" });
    await second.client.auth.login({ password: "test-owner-password" });
    await first.client.auth.logout();
    await expect(first.client.agents.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await second.client.auth.status()).toMatchObject({ authenticated: true });
  });

  it("rejects an expired persistent login", async () => {
    const current = browser();
    const login = await current.client.auth.login({ password: "test-owner-password" });
    expect(login.expiresAt - Date.now()).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    const bindings = env as unknown as Env;
    const hash = await digest(current.cookie().split("=")[1]);
    await runInDurableObject(
      bindings.DEPLOYMENT.get(bindings.DEPLOYMENT.idFromName("deployment")),
      async (_instance, context) => {
        context.storage.sql.exec(
          "UPDATE owner_sessions SET expires_at = ? WHERE token_hash = ?",
          Date.now() - 1,
          hash,
        );
      },
    );
    await expect(current.client.agents.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects a revoked login on reconnect after Deployment leaves memory", async () => {
    const first = browser();
    const second = browser();
    await first.client.auth.login({ password: "test-owner-password" });
    await second.client.auth.login({ password: "test-owner-password" });
    const { agent, sessionId } = await createAgent(first.client, { name: "Watch", persona: "" });
    const eventUrl = `${ORIGIN}/api/events/${agent.id}/${sessionId}`;
    const foreign = await SELF.fetch(eventUrl, {
      headers: { Cookie: first.cookie(), Origin: "https://other.test", Upgrade: "websocket" },
    });
    expect(foreign.status).toBe(403);
    const revokedCookie = first.cookie();
    const revoked = await openChat(revokedCookie, agent.id, sessionId);
    const valid = await openChat(second.cookie(), agent.id, sessionId);
    try {
      await evictDurableObject((env as unknown as Env).DEPLOYMENT.getByName("deployment"));
      await first.client.auth.logout();
      expect(revoked.socket.readyState).toBe(WebSocket.OPEN);
      expect(valid.socket.readyState).toBe(WebSocket.OPEN);
      const reconnect = await SELF.fetch(eventUrl, {
        headers: { Cookie: revokedCookie, Origin: ORIGIN, Upgrade: "websocket" },
      });
      expect(reconnect.status).toBe(401);
    } finally {
      revoked.socket.close();
      valid.socket.close();
    }
  });

  it("pushes new output to the same chat socket after Agent hibernation", async () => {
    mockModel();
    const current = browser();
    await current.client.auth.login({ password: "test-owner-password" });
    const { agent, sessionId } = await createAgent(current.client, { name: "Wake", persona: "" });
    const { socket, packets } = await openChat(current.cookie(), agent.id, sessionId);
    try {
      await evictDurableObject((env as unknown as Env).AGENTS.getByName(agent.id));
      await current.client.sessions.submit({
        agentId: agent.id,
        sessionId,
        operationId: crypto.randomUUID(),
        text: "Wake the sleeping chat",
      });
      await vi.waitFor(() => {
        expect(JSON.stringify(packets)).toContain("Fixture answer: Wake the sleeping chat");
        expect(packets.some(({ type }) => type === "delta")).toBe(true);
      }, NATIVE_WAIT);
      expect(socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      socket.close();
    }
  });

  it("resumes chat from the last seen entry and fills history missed beyond the watch window", async () => {
    const current = browser();
    await current.client.auth.login({ password: "test-owner-password" });
    const { agent, sessionId } = await createAgent(current.client, {
      name: "Transcript recovery",
      persona: "",
    });
    const target = { agentId: agent.id, sessionId };
    const stub = (env as unknown as Env).AGENTS.getByName(agent.id);
    let sequence = 0;
    const append = (count: number) =>
      runInDurableObject(stub, async (instance) => {
        const pi = await instance.harness.pi();
        const conversation = await pi.root(BG);
        return conversation.commit(async (tx) => {
          const entries = [];
          for (let index = 0; index < count; index++) {
            entries.push(
              await tx.appendEntry(conversation.id, {
                kind: "amita.fixture",
                model: [{ role: "user", content: `Message ${++sequence}`, timestamp: sequence }],
              }),
            );
          }
          return entries;
        }, BG);
      });
    const snapshot = async (from?: number) => {
      const { socket, packets } = await openChat(current.cookie(), agent.id, sessionId, from);
      socket.close();
      const packet = packets[0];
      if (packet.type !== "snapshot") throw new Error("Expected an initial snapshot");
      return packet.view;
    };
    const transcript = new ConversationTranscript(
      async (query, limit) => {
        const { entries, next } = await current.client.sessions.history({
          ...target,
          ...query,
          limit,
        });
        return { items: entries, next };
      },
      { pageSize: CONFIG.historyPageSize },
    );

    const initial = await append(CONFIG.historyPageSize + 1);
    transcript.merge(await snapshot());
    const short = await append(2);
    const resumed = await snapshot(transcript.resume?.from);
    expect(resumed.entries).toEqual(short);
    transcript.merge(resumed);

    const missed = await append(CONFIG.historyPageSize * 3);
    const recent = await snapshot(transcript.resume?.from);
    expect(recent.entries).toEqual(missed.slice(-CONFIG.historyPageSize));
    let view = transcript.merge(recent);
    for (let page = 0; page < 2; page++) {
      const gap = view.items.find((item) => item.kind === "gap");
      if (!gap) throw new Error("Expected a gap before the next history page");
      view = await transcript.fillGap(gap, BG);
    }
    expect(view.items.some((item) => item.kind === "gap")).toBe(false);
    expect(view.items[0]?.kind).toBe("earlier");
    view = await transcript.loadEarlier(BG);
    expect(view.items.map((item) => item.kind === "entry" && item.entry.id)).toEqual(
      [...initial, ...short, ...missed].map((entry) => entry.id),
    );
  });

  it("stops one native conversation and its queued steer while another keeps running", async () => {
    let attempts = 0;
    mockModel(() => {
      attempts++;
      return true;
    });
    const { client } = browser();
    await client.auth.login({ password: "test-owner-password" });
    const created = await createAgent(client, { name: "Concurrent", persona: "" });
    const second = await client.sessions.create({ agentId: created.agent.id });
    const firstInput = {
      agentId: created.agent.id,
      sessionId: created.sessionId,
      operationId: crypto.randomUUID(),
      text: "First ongoing input",
    };
    const secondInput = {
      agentId: created.agent.id,
      sessionId: second.id,
      operationId: crypto.randomUUID(),
      text: "Second ongoing input",
    };
    await client.sessions.submit(firstInput);
    await client.sessions.submit(secondInput);
    await vi.waitFor(() => expect(attempts).toBe(2), NATIVE_WAIT);
    await client.sessions.submit({
      ...firstInput,
      operationId: crypto.randomUUID(),
      text: "Queued steering input",
    });
    await client.sessions.stop(firstInput);
    const sessions = await client.sessions.list({ agentId: created.agent.id });
    expect(sessions.find((session) => session.id === firstInput.sessionId)?.busy).toBe(false);
    expect(sessions.find((session) => session.id === secondInput.sessionId)?.busy).toBe(true);
    const history = await client.sessions.history(firstInput);
    expect(JSON.stringify(history.entries)).not.toContain("Queued steering input");
    expect(
      history.entries
        .flatMap((entry) => entry.model ?? [])
        .filter((message) => message.role === "user"),
    ).toHaveLength(1);
    await client.sessions.stop(secondInput);
  });

  it("deduplicates lost-receipt retries and preserves native history after DO restart", async () => {
    mockModel();
    const { client } = browser();
    await client.auth.login({ password: "test-owner-password" });
    const created = await createAgent(client, { name: "Native", persona: "Use short answers." });
    const input = {
      agentId: created.agent.id,
      sessionId: created.sessionId,
      operationId: crypto.randomUUID(),
      text: "Unique input",
    };
    expect((await client.sessions.submit(input)).accepted).toBe(true);
    expect((await client.sessions.submit(input)).accepted).toBe(false);
    await vi.waitFor(async () => {
      const page = await client.sessions.history(input);
      expect(JSON.stringify(page.entries)).toContain("Fixture answer: Unique input");
    }, NATIVE_WAIT);
    const bindings = env as unknown as Env;
    await evictDurableObject(bindings.AGENTS.get(bindings.AGENTS.idFromName(created.agent.id)));
    expect((await client.sessions.submit(input)).accepted).toBe(false);
    const page = await client.sessions.history(input);
    const users = page.entries
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "user");
    expect(users).toHaveLength(1);
    expect(JSON.stringify(page.entries)).toContain("Fixture answer: Unique input");
    expect((await client.sessions.list({ agentId: input.agentId }))[0].title).toBe("Unique input");
  });

  it("keeps the original persona across ordinary requests in a Session", async () => {
    const model = mockModel();
    const { client } = browser();
    await client.auth.login({ password: "test-owner-password" });
    const created = await createAgent(client, { name: "Persona", persona: "PERSONA_ALPHA" });
    const target = { agentId: created.agent.id, sessionId: created.sessionId };
    await client.sessions.submit({
      ...target,
      text: "Initial persona request",
      operationId: crypto.randomUUID(),
    });
    await vi.waitFor(
      async () =>
        expect(JSON.stringify((await client.sessions.history(target)).entries)).toContain(
          "Fixture answer: Initial persona request",
        ),
      NATIVE_WAIT,
    );
    expect(JSON.stringify(model.requests[0].messages)).toContain("PERSONA_ALPHA");
    const { version } = await client.agents.persona({ agentId: target.agentId });
    await client.agents.savePersona({
      agentId: target.agentId,
      persona: "PERSONA_BETA",
      expectedVersion: version,
    });
    await client.sessions.submit({
      ...target,
      text: "Updated persona request",
      operationId: crypto.randomUUID(),
    });
    await vi.waitFor(
      async () =>
        expect(JSON.stringify((await client.sessions.history(target)).entries)).toContain(
          "Fixture answer: Updated persona request",
        ),
      NATIVE_WAIT,
    );
    expect(JSON.stringify(model.requests.at(-1)!.messages)).toContain("PERSONA_ALPHA");
    expect(JSON.stringify(model.requests.at(-1)!.messages)).not.toContain("PERSONA_BETA");
  });

  it("recovers an admitted native run after losing its DO instance", async () => {
    let attempts = 0;
    mockModel(() => ++attempts === 1);
    const { client } = browser();
    await client.auth.login({ password: "test-owner-password" });
    const created = await createAgent(client, {
      name: "Recovery",
      persona: "Continue after restart.",
    });
    const input = {
      agentId: created.agent.id,
      sessionId: created.sessionId,
      operationId: crypto.randomUUID(),
      text: "Recover this input",
    };
    await client.sessions.submit(input);
    await vi.waitFor(() => expect(attempts).toBe(1), NATIVE_WAIT);
    await abortAllDurableObjects();
    await vi.waitFor(async () => {
      const page = await client.sessions.history(input);
      expect(JSON.stringify(page.entries)).toContain("Fixture answer: Recover this input");
    }, NATIVE_WAIT);
  });
});

function mockModel(hold: () => boolean = () => false) {
  const original = globalThis.fetch;
  const requests: { model: string; messages: { role: string; content: string }[] }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (resource, options) => {
    const request = new Request(resource, options);
    if (!request.url.startsWith("https://api.deepseek.com/")) return original(resource, options);
    const body = (await request.json()) as {
      model: string;
      messages: { role: string; content: string }[];
      thinking?: { type: string };
    };
    const naming = body.thinking?.type === "disabled";
    if (!naming) requests.push(body);
    const input =
      [...body.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const encoder = new TextEncoder();
    const held = !naming && hold();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = (delta: unknown, finish_reason: string | null = null) =>
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
            ),
          );
        chunk({ role: "assistant", reasoning_content: "Fixture reasoning." });
        if (held) {
          request.signal.addEventListener(
            "abort",
            () => controller.error(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
          return;
        }
        chunk({ content: naming ? input.slice(0, 64) : `Fixture answer: ${input}` });
        chunk({}, "stop");
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  });
  return { requests };
}
