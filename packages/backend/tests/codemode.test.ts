import { createAgent } from "./helpers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { appendMessage, modelFixture, owner, WAIT } from "./helpers";

afterEach(() => vi.restoreAllMocks());

function scriptedModel(scripts: Record<string, string>) {
  return modelFixture(({ messages }) => {
    const user = messages.findLastIndex((message) => message.role === "user");
    if (messages.slice(user + 1).some((message) => message.role === "tool"))
      return { text: "CODEMODE_FIXTURE_DONE" };
    const content = messages[user]?.content;
    const name = typeof content === "string" ? content : JSON.stringify(content);
    return { tool: { name: "codemode", arguments: { code: scripts[name] ?? "return 42;" } } };
  });
}

async function conversation() {
  const session = owner();
  await session.login();
  const created = await createAgent(session.client, { name: "Native Code Mode", persona: "" });
  return { ...session, agentId: created.agent.id, sessionId: created.sessionId };
}

async function execute(
  session: Awaited<ReturnType<typeof conversation>>,
  text: string,
): Promise<ToolResultMessage> {
  const target = { agentId: session.agentId, sessionId: session.sessionId };
  const before = await session.client.sessions.history(target);
  const cursor = Number(before.entries.at(-1)?.id ?? 0);
  await session.client.sessions.submit({ ...target, text, operationId: crypto.randomUUID() });
  let result: ToolResultMessage | undefined;
  await vi.waitFor(async () => {
    const history = await session.client.sessions.history(target);
    const messages = history.entries
      .filter((entry) => Number(entry.id) > cursor)
      .flatMap((entry) => entry.model ?? []);
    result = messages.find(
      (message): message is ToolResultMessage => message.role === "toolResult",
    );
    expect(
      messages.some((message) => message.role === "assistant" && message.stopReason === "stop"),
    ).toBe(true);
    expect(
      (await session.client.sessions.list({ agentId: session.agentId })).find(
        (item) => item.id === session.sessionId,
      )?.busy,
    ).toBe(false);
    expect(result).toBeDefined();
  }, WAIT);
  return result!;
}

const textOf = (result: ToolResultMessage) =>
  result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");

describe("Agent native Code Mode selection", () => {
  it("inlines every built-in Code Mode tool within the configured budget", async () => {
    const request = "List the Code Mode tools";
    const model = scriptedModel({ [request]: "return ALL_TOOLS.map(({ name }) => name);" });
    const result = await execute(await conversation(), request);
    expect(result.isError, textOf(result)).toBe(false);
    const output = result.content.findLast((part) => part.type === "text");
    const available: string[] = JSON.parse(output?.text ?? "[]");
    expect(available.length).toBeGreaterThan(0);

    const system = model.requests[0]!.messages.filter(({ role }) => role === "system")
      .map(({ content }) => content)
      .join("\n");
    const catalog = system.match(/<codemode>\n([\s\S]*?)\n<\/codemode>/)?.[1] ?? "";
    const inlined = new Set(Array.from(catalog.matchAll(/^### `([^`]+)`/gm), ([, name]) => name));
    const missing = available.filter((name) => !inlined.has(name));
    expect(
      missing,
      `Increase Code Mode inlineBudget to include these built-in tools: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("discovers an internal Skill and reads its instructions and reference on demand", async () => {
    const directory = "/internal/skills/report-review";
    const path = `${directory}/SKILL.md`;
    const instruction = "Read references/checklist.md before reviewing a report.";
    const checklist = "Check the source of each reported number.";
    const files = [
      [
        path,
        `---\nname: report-review\ndescription: >-\n  Review facts & figures.\n---\n${instruction}\n`,
      ],
      [`${directory}/references/checklist.md`, checklist],
      [
        "/internal/skills/hidden/SKILL.md",
        "---\nname: hidden\ndescription: Hidden Skill.\ndisable-model-invocation: true\n---\n",
      ],
      ["/internal/skills/invalid/SKILL.md", "---\nname: invalid\ndescription: [broken\n---\n"],
    ];
    const prompt = (messages: { role: string; content: unknown }[]) =>
      messages
        .filter(({ role }) => role === "system")
        .map(({ content }) => content)
        .join("\n");
    const model = modelFixture(({ messages }) => {
      const user = messages.findLastIndex(({ role }) => role === "user");
      if (messages.slice(user + 1).some(({ role }) => role === "tool")) return { text: "Done." };
      if (messages[user]?.content === "Install the Skill") {
        return {
          tool: {
            name: "codemode",
            arguments: {
              code: files
                .map(
                  ([path, content]) =>
                    `await tools.fs_write(${JSON.stringify({ path, content })});`,
                )
                .join("\n"),
            },
          },
        };
      }
      const location = prompt(messages).match(/<location>([^<]+)<\/location>/)?.[1];
      return {
        tool: {
          name: "codemode",
          arguments: {
            code: `
              const path = ${JSON.stringify(location ?? "")};
              const instructions = await tools.fs_read({ path });
              const reference = instructions.match(/references\\/checklist\\.md/)[0];
              const checklist = await tools.fs_read({ path: path.slice(0, path.lastIndexOf("/")) + "/" + reference });
              return { instructions, checklist };
            `,
          },
        },
      };
    });

    const session = await conversation();
    expect((await execute(session, "Install the Skill")).isError).toBe(false);
    expect(prompt(model.requests[0]!.messages)).not.toContain("<available_skills>");

    const fresh = await session.client.sessions.create({ agentId: session.agentId });
    const since = model.requests.length;
    const result = await execute({ ...session, sessionId: fresh.id }, "Review a report");
    const system = prompt(model.requests[since]!.messages);
    expect(system).toContain("<available_skills>");
    expect(system).toContain("<name>report-review</name>");
    expect(system).toContain("<description>Review facts &amp; figures.</description>");
    expect(system).toContain(`<location>${path}</location>`);
    expect(system).not.toContain("<name>hidden</name>");
    expect(system).not.toContain("<name>invalid</name>");
    expect(system).not.toContain(instruction);
    expect(system).not.toContain(checklist);
    expect(result.isError, textOf(result)).toBe(false);
    expect(textOf(result)).toContain(instruction);
    expect(textOf(result)).toContain(checklist);
  });

  it("lets scripts save typed search hits to Memory", async () => {
    scriptedModel({
      remember: `
        const hits = await tools.session_search({ query: "Silver Orchard" });
        const path = "/internal/MEMORY.md";
        await tools.fs_write({ path, content: hits[0].text });
        return await tools.fs_read({ path });
      `,
    });
    const session = await conversation();
    const memory = "The project is called Silver Orchard.";
    await appendMessage(session.agentId, session.sessionId, "user", memory);
    const result = await execute(session, "remember");
    expect(result.isError, textOf(result)).toBe(false);
    expect(textOf(result)).toContain(memory);
    expect(await session.client.agents.memory({ agentId: session.agentId })).toEqual({ memory });
  });

  it("commits store on success, rolls it back on script errors, and scopes load to a Conversation", async () => {
    scriptedModel({
      save: 'store("answer", 42); return "saved";',
      fail: 'store("answer", 999); throw new Error("fixture-script-error");',
      load: 'return { answer: load("answer") ?? null };',
    });
    const session = await conversation();
    expect((await execute(session, "save")).isError).toBe(false);
    const failed = await execute(session, "fail");
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain("fixture-script-error");
    expect(textOf(await execute(session, "load"))).toContain('"answer":42');
    const next = await session.client.sessions.create({ agentId: session.agentId });
    expect(textOf(await execute({ ...session, sessionId: next.id }, "load"))).toContain(
      '"answer":null',
    );
  });

  it("returns images even when no file storage is configured", async () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAACAUlEQVR42u3TAQkAAAgDQTGNEY1oLAvYwDuWYPBRPWZvlwGPCQABgABAACAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABgABAAAgABAACAAGAAEAAIAAQAAgABAACAAGAAEAAIAAQAAgABAACAAGAAEAAIAAQAAgABAACAAGAAEAAIAAQAAgABAACAAGAAEAAIAAQAAgABAACAAGAAEAAIAAQAAgABAACAAEgABAACAAEAAIAAYAAQAAgABAACAAEAAIAAYAAQAAgABAACAAEAAIAAYAAQAAgABAACAAEAAIAAYAAQAAgABAACAAEAAIAAYAAQAAgABAACAAEAAIAAYAAQAAgABAACAABuAABgABAACAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABgABAACAAEAAIAAQAAgABgABAAAgABAACAAGAAEAAIAAQAAgABAACAAGAAEAAIAAQAAgABAACAAGAAEAAIAAQAAgABAACAAGAAEAAIAAQAAgABAACAAGAAEAAIAAQAAgABAACAAGAAEAAIAC4LBolag45kL5YAAAAAElFTkSuQmCC";
    scriptedModel({
      overflow:
        '// @options: {"max_output_tokens":128}\ntext("HEAD-OF-OUTPUT" + "x".repeat(20000) + "TAIL-OF-OUTPUT");',
      image: `image("data:image/png;base64,${png}"); return "IMAGE-SCRIPT-DONE";`,
    });
    const session = await conversation();
    const shown = await execute(session, "image");
    expect(shown.isError).toBe(false);
    expect(shown.content).toContainEqual({ type: "image", data: png, mimeType: "image/png" });
    expect(textOf(shown)).toContain("IMAGE-SCRIPT-DONE");
  });
});
