import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { Env } from "../src/env";
import { agent, pairingCommand, telegram } from "./channels-fixture";
import { WAIT } from "./helpers";

afterEach(() => vi.restoreAllMocks());

async function paired(fixture: ReturnType<typeof telegram>) {
  const { client, agentId } = await agent();
  const { id } = await client.channels.connect({
    agentId,
    token: "481:fixture",
  });
  const link = await client.channels.pair({ agentId, id });
  expect((await fixture.send(id, 1, pairingCommand(link.url))).status).toBe(200);
  return { client, agentId, id };
}

it("resumes a rate-limited reply after eviction without another model turn", async () => {
  const line = "中文 😃".repeat(900);
  const fixture = telegram({
    text: "```text\n" + line + "\n```",
    onSend: (_body, count) =>
      count === 1
        ? Response.json(
            { ok: false, error_code: 429, parameters: { retry_after: 2 } },
            { status: 429 },
          )
        : undefined,
  });
  const { agentId, id } = await paired(fixture);
  expect((await fixture.send(id, 2, "Give me a long formatted answer")).status).toBe(200);
  const stub = (env as unknown as Env).AGENTS.getByName(agentId);
  await vi.waitFor(async () => {
    const page = await runInDurableObject(stub, async (instance) =>
      (await instance.harness.pi()).commit(
        (tx) => tx.scanTasks({ kind: "amita.channel.delivery", status: "sleeping" }, 1),
        BG,
      ),
    );
    expect(page.items).toHaveLength(1);
  }, WAIT);
  await evictDurableObject(stub);
  expect((await fixture.send(id, 2, "Give me a long formatted answer")).status).toBe(200);
  await vi.waitFor(() => expect(fixture.outbound).toHaveLength(3), WAIT);
  const [first, retry, remainder] = fixture.outbound.map((item) => String(item.text));
  expect(first).toBe(retry);
  expect(first).not.toBe(remainder);
  for (const part of [retry, remainder]) {
    expect(part.length).toBeLessThanOrEqual(4096);
    expect(part).toMatch(/^```text\n.*```$/s);
  }
  expect(fixture.model.requests).toHaveLength(1);
});

it("reports an unknown outcome without repeating the original send", async () => {
  const fixture = telegram({
    text: "One reply",
    onSend: (_body, count) => {
      if (count === 1) throw new TypeError("Connection dropped after sending");
    },
  });
  const { id } = await paired(fixture);
  expect((await fixture.send(id, 2, "Send one reply")).status).toBe(200);
  await vi.waitFor(() => expect(fixture.outbound).toHaveLength(1), WAIT);
  expect(fixture.outbound[0].text).toBe("One reply");
  expect(fixture.model.requests).toHaveLength(1);
});

it("sends to the exact current Topic and requires an explicit target from Web", async () => {
  let selection: { target?: "current"; destinationId?: string } = { target: "current" };
  const fixture = telegram({
    model: ({ messages }) =>
      messages.some(({ role }) => role === "tool")
        ? { text: "Final reply" }
        : { tool: { name: "channel_send", arguments: { ...selection, text: "Proactive notice" } } },
  });
  const { client, agentId, id } = await paired(fixture);
  const before = new Set((await client.sessions.list({ agentId })).map(({ id }) => id));
  expect((await fixture.send(id, 2, "Send this here", 991, 800)).status).toBe(200);
  await vi.waitFor(
    () =>
      expect(fixture.outbound).toContainEqual(
        expect.objectContaining({ message_thread_id: 800, text: "Final reply" }),
      ),
    WAIT,
  );
  const notices = () => fixture.outbound.filter(({ text }) => text === "Proactive notice");
  expect(notices()).toMatchObject([{ message_thread_id: 800 }]);
  const origin = (await client.sessions.list({ agentId })).find(({ id }) => !before.has(id))!;
  const { entries } = await client.sessions.history({ agentId, sessionId: origin.id });
  const channelResult = entries
    .flatMap(({ model }) => model ?? [])
    .find(({ role }) => role === "toolResult");
  expect(channelResult).toMatchObject({ isError: false });
  if (channelResult?.role !== "toolResult" || channelResult.content[1]?.type !== "text")
    throw new Error("Missing channel_send tool result");
  const dest = JSON.parse(channelResult.content[1].text).destination.id as string;

  const sendFromWeb = async () => {
    const { id: sessionId } = await client.sessions.create({ agentId });
    const session = { agentId, sessionId };
    await client.sessions.submit({
      ...session,
      text: "Send a proactive notice",
      operationId: crypto.randomUUID(),
    });
    return vi.waitFor(async () => {
      const { entries } = await client.sessions.history(session);
      const result = entries
        .flatMap(({ model }) => model ?? [])
        .find(({ role }) => role === "toolResult");
      expect(result).toBeDefined();
      return result;
    }, WAIT);
  };
  const denied = await sendFromWeb();
  expect(JSON.stringify(denied?.content)).toContain("Choose a destination explicitly");
  expect(notices()).toHaveLength(1);

  selection = { destinationId: dest };
  expect(await sendFromWeb()).toMatchObject({ isError: false });
  expect(notices()).toMatchObject([{ message_thread_id: 800 }, { message_thread_id: 800 }]);
});

it("cancels remaining split sends and retains the first receipt through Pi", async () => {
  let attempts = 0;
  const fixture = telegram({
    model: ({ messages }) =>
      messages.some(({ role }) => role === "tool")
        ? { text: "Finished" }
        : {
            tool: {
              name: "channel_send",
              arguments: { target: "current", text: "PAYLOAD ".repeat(800) },
            },
          },
    onSend: ({ text }) => {
      if (!String(text).startsWith("PAYLOAD")) return;
      if (++attempts === 2)
        return Response.json(
          { ok: false, error_code: 429, parameters: { retry_after: 30 } },
          { status: 429 },
        );
    },
  });
  const { agentId, id } = await paired(fixture);
  await fixture.send(id, 2, "Send the long message", 991, 810);
  await vi.waitFor(() => expect(attempts).toBe(2), WAIT);
  await fixture.send(id, 3, "/stop", 991, 810);
  const stub = (env as unknown as Env).AGENTS.getByName(agentId);
  await vi.waitFor(async () => {
    const page = await runInDurableObject(stub, async (instance) =>
      (await instance.harness.pi()).commit(
        (tx) => tx.scanTasks({ kind: "amita.channel.delivery", status: "terminal" }, 100),
        BG,
      ),
    );
    expect(
      page.items.some((task) => {
        const result = task.state.outcome?.result;
        return (
          result !== null &&
          typeof result === "object" &&
          !Array.isArray(result) &&
          result.status === "cancelled" &&
          Array.isArray(result.receipts) &&
          result.receipts.length === 1
        );
      }),
    ).toBe(true);
  }, WAIT);
  expect(attempts).toBe(2);
});
