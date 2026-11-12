import { afterEach, expect, it, vi } from "vite-plus/test";
import { agent, pairingCommand, telegram } from "./channels-fixture";
import { WAIT } from "./helpers";

afterEach(() => vi.restoreAllMocks());

it("lists paired chats and distinguishes same-name Topics while retaining IDs after rename", async () => {
  let query = "";
  const fixture = telegram({
    model: ({ messages }) =>
      messages.some(({ role }) => role === "tool")
        ? { text: "Directory ready" }
        : { tool: { name: "channel_list", arguments: { query } } },
  });
  const { client, agentId } = await agent();
  const { id } = await client.channels.connect({ agentId, token: "470:fixture" });
  const link = await client.channels.pair({ agentId, id });
  await fixture.send(id, 1, pairingCommand(link.url));

  const list = async (term: string) => {
    query = term;
    const { id: sessionId } = await client.sessions.create({ agentId });
    const target = { agentId, sessionId };
    await client.sessions.submit({
      ...target,
      text: "Look up the channels",
      operationId: crypto.randomUUID(),
    });
    let destinations: Array<{ id: string; platform: string; label: string; canSend: boolean }> = [];
    await vi.waitFor(async () => {
      const { entries } = await client.sessions.history(target);
      const result = entries
        .flatMap(({ model }) => model ?? [])
        .find((message) => message.role === "toolResult");
      if (result?.role !== "toolResult") throw new Error("Waiting for channel_list tool result");
      expect(result?.isError).toBe(false);
      const part = result.content[1];
      if (part?.type !== "text") throw new Error("Missing channel_list output");
      ({ destinations } = JSON.parse(part.text));
    }, WAIT);
    return destinations;
  };

  const privateChat = await list("OWNER");
  expect(privateChat).toEqual([
    {
      id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      platform: "telegram",
      label: "@bot_470 / Owner",
      canSend: true,
    },
  ]);

  await fixture.send(id, 2, { forum_topic_created: { name: "日报" } }, 991, 50);
  await fixture.send(id, 3, { forum_topic_created: { name: "日报" } }, 991, 60);
  await fixture.send(id, 4, { forum_topic_created: { name: "项目日报" } }, 991, 70);
  const before = await list("日报");
  expect(before.map(({ label }) => label)).toEqual([
    "@bot_470 / Owner / 日报",
    "@bot_470 / Owner / 日报",
    "@bot_470 / Owner / 项目日报",
  ]);
  expect(new Set(before.map(({ id }) => id)).size).toBe(3);

  await fixture.send(id, 5, { forum_topic_edited: { name: "周报" } }, 991, 50);
  await fixture.send(id, 6, { forum_topic_closed: {} }, 991, 50);
  const [renamed] = await list("周报");
  expect(renamed).toEqual({
    id: before[0]?.id,
    platform: "telegram",
    label: "@bot_470 / Owner / 周报",
    canSend: false,
  });

  await fixture.send(id, 7, {
    text: "/status",
    chat: { id: 991, type: "private", first_name: "Updated Owner" },
  });
  expect(await list("Updated Owner")).toEqual([
    { ...privateChat[0], label: "@bot_470 / Updated Owner" },
  ]);

  await client.channels.disconnect({ agentId, id });
  expect(await list("owner")).toEqual([]);
});
