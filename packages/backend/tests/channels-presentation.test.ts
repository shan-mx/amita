import { env, runInDurableObject } from "cloudflare:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { Env } from "../src/env";
import { agent, pairingCommand, telegram } from "./channels-fixture";
import { WAIT } from "./helpers";

afterEach(() => vi.restoreAllMocks());

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("publishes each text block and top-level tool input in order for a shared Telegram turn", async () => {
  const startTool = gate();
  const finishRun = gate();
  const code = "return await tools.channel_list({}); /*\n```\n" + "`\\中文".repeat(1000) + " */";
  const command = "printf '%s\\n' hello";
  const fixture = telegram({
    model: async ({ messages }) => {
      const results = messages.filter(({ role }) => role === "tool");
      if (results.length === 3) {
        await finishRun.promise;
        return { text: "Here is the result" };
      }
      if (results.length === 2)
        return {
          tool: { name: "bash", arguments: { command, computer: "fixture", timeout: 2 } },
        };
      if (results.length === 1)
        return {
          text: "I will read the file",
          tool: { name: "fs_read", arguments: { path: "/notes.md", offset: 2, limit: 3 } },
        };
      await startTool.promise;
      return {
        text: "I will check the destinations",
        tool: { name: "codemode", arguments: { code } },
      };
    },
  });
  const { client, agentId } = await agent();
  const { id } = await client.channels.connect({ agentId, token: "363:fixture" });
  const link = await client.channels.pair({ agentId, id });
  await fixture.send(id, 1, pairingCommand(link.url));
  try {
    await fixture.send(id, 2, "Check the destinations", 991, 544);
    await vi.waitFor(() => expect(fixture.model.requests).toHaveLength(1), WAIT);
    await vi.waitFor(
      () =>
        expect(fixture.calls.filter(({ method }) => method === "sendChatAction")).toMatchObject([
          { body: { action: "typing", chat_id: 991, message_thread_id: 544 } },
          { body: { action: "typing", chat_id: 991, message_thread_id: 544 } },
        ]),
      WAIT,
    );
    expect(fixture.outbound).toEqual([]);
    await fixture.send(id, 3, "Also read the file", 991, 544);
    startTool.resolve();
    await vi.waitFor(() => expect(fixture.outbound.at(-1)?.text).toContain("💻 bash"), WAIT);

    const received = fixture.outbound.map(({ text }) => String(text));
    expect(received[0]).toBe("I will check the destinations");
    const beforeRead = received.indexOf("I will read the file");
    expect(beforeRead).toBeGreaterThan(2);
    expect(
      received
        .slice(1, beforeRead)
        .join("\n")
        .match(/🧩 codemode/g),
    ).toHaveLength(1);
    expect(received[1]).toMatch(/^🧩 codemode\n```javascript\n/);
    const blocks = received.slice(1, beforeRead).map((message) => {
      expect(message.length).toBeLessThanOrEqual(4096);
      const block = message.match(/```javascript\n([\s\S]*)\n```$/)?.[1];
      if (block === undefined) throw new Error("Missing code block in tool input");
      return block.replace(/\\([`\\])/g, "$1");
    });
    let offset = 0;
    for (const [index, block] of blocks.entries()) {
      // SDK splitting may consume a newline only at a message boundary.
      if (index > 0 && code[offset] === "\n" && !code.startsWith(block, offset)) offset++;
      expect(code.slice(offset, offset + block.length)).toBe(block);
      offset += block.length;
    }
    expect(offset).toBe(code.length);
    expect(received[beforeRead + 1]).toBe("📖 fs\\_read\n`/notes.md (L2-L4)`");
    expect(received[beforeRead + 2]).toContain(
      "💻 bash\n```bash\n" + command.replaceAll("\\", "\\\\"),
    );
    expect(received[beforeRead + 2]).toContain('"computer": "fixture"');
    expect(received[beforeRead + 2]).toContain('"timeout": 2');
    expect(fixture.outbound.every(({ message_thread_id }) => message_thread_id === 544)).toBe(true);

    finishRun.resolve();
    await vi.waitFor(() => expect(fixture.outbound.at(-1)?.text).toBe("Here is the result"), WAIT);
    expect(fixture.outbound.map(({ text }) => text)).toEqual([...received, "Here is the result"]);
    expect(JSON.stringify(fixture.model.requests)).toContain("Also read the file");
    expect(fixture.calls.map(({ method }) => method)).not.toContain("sendMessageDraft");
    expect(fixture.calls.map(({ method }) => method)).not.toContain("editMessageText");
  } finally {
    startTool.resolve();
    finishRun.resolve();
  }
});

it("keeps already published text and tool input when Telegram stops the turn", async () => {
  const followup = gate();
  const fixture = telegram({
    model: async ({ messages }, signal) => {
      if (messages.some(({ role }) => role === "tool")) {
        followup.resolve();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { text: "This turn was stopped" };
      }
      return { text: "I will check", tool: { name: "channel_list", arguments: {} } };
    },
  });
  const { client, agentId } = await agent();
  const { id } = await client.channels.connect({ agentId, token: "359:fixture" });
  const link = await client.channels.pair({ agentId, id });
  await fixture.send(id, 1, pairingCommand(link.url));
  await fixture.send(id, 2, "Begin the run", 991, 541);
  await followup.promise;
  await vi.waitFor(() => expect(fixture.outbound.at(-1)?.text).toContain("🧩 codemode"), WAIT);
  const before = fixture.outbound.slice();
  expect(before).toHaveLength(2);
  expect(before[0]?.text).toBe("I will check");

  await fixture.send(id, 3, "/stop", 991, 541);
  await vi.waitFor(
    () => expect(fixture.outbound.at(-1)?.text).toContain("Stopped the conversation"),
    WAIT,
  );
  expect(fixture.outbound.slice(0, -1)).toEqual(before);
  expect(fixture.calls.map(({ method }) => method)).not.toContain("deleteMessage");
});

it("routes shared Web replies to Telegram and publishes their tool inputs", async () => {
  const run = gate();
  const fixture = telegram({
    model: async ({ messages }) => {
      if (!JSON.stringify(messages).includes("Web originated marker"))
        return { text: "Session ready" };
      const toolResults = messages.filter(({ role }) => role === "tool").length;
      if (toolResults === 2) return { text: "Shared Web answer" };
      if (toolResults === 1)
        return {
          text: "I will read the file",
          tool: { name: "fs_read", arguments: { path: "/web-only.md" } },
        };
      await run.promise;
      return { tool: { name: "channel_list", arguments: {} } };
    },
  });
  const { client, agentId } = await agent();
  const before = new Set((await client.sessions.list({ agentId })).map(({ id }) => id));
  const { id } = await client.channels.connect({ agentId, token: "362:fixture" });
  const link = await client.channels.pair({ agentId, id });
  await fixture.send(id, 1, pairingCommand(link.url));
  await fixture.send(id, 2, "Seed the Telegram conversation", 991, 543);
  try {
    await vi.waitFor(() => expect(fixture.outbound[0]?.text).toBe("Session ready"), WAIT);
    const session = (await client.sessions.list({ agentId })).find(({ id }) => !before.has(id))!;
    await client.sessions.submit({
      agentId,
      sessionId: session.id,
      operationId: crypto.randomUUID(),
      text: "Web originated marker",
    });
    await vi.waitFor(
      () => expect(JSON.stringify(fixture.model.requests)).toContain("Web originated marker"),
      WAIT,
    );
    await fixture.send(id, 3, "Include this Telegram input", 991, 543);
    const stub = (env as unknown as Env).AGENTS.getByName(agentId);
    await vi.waitFor(async () => {
      const state = await runInDurableObject(stub, async (instance) =>
        (await instance.harness.pi()).inspect(BG),
      );
      expect(state.submissions.filter(({ type }) => type === "input")).toHaveLength(2);
    }, WAIT);
    run.resolve();
    await vi.waitFor(() => expect(fixture.outbound.at(-1)?.text).toBe("Shared Web answer"), WAIT);
    const published = fixture.outbound.map(({ text }) => String(text));
    expect(published).toEqual(
      expect.arrayContaining(["Session ready", "I will read the file", "Shared Web answer"]),
    );
    expect(published.some((text) => text.includes("/web-only.md"))).toBe(true);
  } finally {
    run.resolve();
  }
});
