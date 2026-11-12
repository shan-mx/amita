import { createAgent } from "./helpers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { env, evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { CompactionEntry, SystemEntry } from "@earendil-works/pi-durable";
import type { Env } from "../src/env";
import { automationTriggerSoon, appendMessage, modelFixture, owner, WAIT } from "./helpers";
afterEach(() => vi.restoreAllMocks());

describe("Agent memory and Session history", () => {
  it("accepts full Owner Memory replacements and keeps the existing length limit", async () => {
    const { client, login } = owner();
    await login();
    const { agent } = await createAgent(client, { name: "Memory limits", persona: "" });
    const target = { agentId: agent.id };
    expect(await client.agents.memory(target)).toEqual({ memory: "" });
    await client.agents.saveMemory({ ...target, memory: "Alpha" });
    expect(await client.agents.saveMemory({ ...target, memory: "Beta" })).toEqual({
      memory: "Beta",
    });
    expect(await client.agents.memory(target)).toEqual({ memory: "Beta" });
    const full = "😀".repeat(4000);
    await client.agents.saveMemory({ ...target, memory: full });
    await expect(
      client.agents.saveMemory({ ...target, memory: full + "😀" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await client.agents.memory(target)).toEqual({ memory: full });
  });

  it("shares Persona and Memory with Pi file edits and protects a stale Owner Persona", async () => {
    const { client, login } = owner();
    await login();
    const created = await createAgent(client, { name: "Shared files", persona: "Be concise." });
    const agentId = created.agent.id;
    const target = { agentId, sessionId: created.sessionId };
    const persona = await client.agents.persona({ agentId });
    expect(persona.persona).toBe("Be concise.");
    await client.agents.update({ agentId, name: "Renamed Agent" });
    expect(await client.agents.persona({ agentId })).toEqual(persona);
    await client.agents.saveMemory({ agentId, memory: "Owner-written baseline." });

    modelFixture(({ messages }) =>
      messages.some(({ role }) => role === "tool")
        ? { text: "EDITED_SHARED_FILES" }
        : {
            tool: {
              name: "codemode",
              arguments: {
                code: `
await tools.fs_edit({path:"/internal/PERSONA.md",edits:[{oldText:"Be concise.",newText:"Be direct."}]});
await tools.fs_edit({path:"/internal/MEMORY.md",edits:[{oldText:"Owner-written baseline.",newText:"The owner prefers jasmine tea."}]});
return await tools.fs_remove({path:"/internal/notes/../PERSONA.md"}).catch(String);
`,
              },
            },
          },
    );
    await client.sessions.submit({
      ...target,
      text: "Edit both files.",
      operationId: crypto.randomUUID(),
    });
    await vi.waitFor(async () => {
      const history = JSON.stringify((await client.sessions.history(target)).entries);
      expect(history).toContain("EDITED_SHARED_FILES");
      expect(history).toContain(
        "Cannot remove /internal/PERSONA.md because it is reserved. To clear it, use fs_write with empty content.",
      );
    }, WAIT);

    const bindings = env as unknown as Env;
    await evictDurableObject(bindings.AGENTS.getByName(agentId));
    expect(await client.agents.memory({ agentId })).toEqual({
      memory: "The owner prefers jasmine tea.",
    });
    expect(await client.agents.persona({ agentId })).toMatchObject({ persona: "Be direct." });
    await expect(
      client.agents.savePersona({
        agentId,
        persona: "Stale draft.",
        expectedVersion: persona.version,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const latest = await client.agents.persona({ agentId });
    expect(latest.persona).toBe("Be direct.");
    await client.agents.savePersona({ agentId, persona: "", expectedVersion: latest.version });
    expect((await client.agents.persona({ agentId })).persona).toBe("");
  });

  it("freezes the conversation baseline at creation and refreshes it together after native compaction", async () => {
    const { client, login } = owner();
    await login();
    const setSkillDescription = "Set skill description to ";
    const model = modelFixture(({ messages }) => {
      const user = messages.findLastIndex(({ role }) => role === "user");
      const text = messages[user]?.content;
      if (
        typeof text === "string" &&
        text.startsWith(setSkillDescription) &&
        !messages.slice(user + 1).some(({ role }) => role === "tool")
      ) {
        const description = text.slice(setSkillDescription.length);
        const file = {
          path: "/internal/skills/context-check/SKILL.md",
          content: `---\nname: context-check\ndescription: ${description}\n---\n`,
        };
        return {
          tool: {
            name: "codemode",
            arguments: { code: `return await tools.fs_write(${JSON.stringify(file)});` },
          },
        };
      }
      return { text: "Context check reply." };
    });
    const pair = async (slug: string, name: string) => {
      const { code } = await client.computer.registration();
      const response = await SELF.fetch("https://amita.test/api/companion/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, name }),
      });
      expect(response.ok).toBe(true);
      const { deviceId } = await response.json<{ deviceId: string }>();
      await client.computer.confirm({ deviceId, slug });
      return deviceId;
    };

    const oldComputer = await pair("context-old", "Old Computer");
    const created = await createAgent(client, { name: "Frozen context", persona: "PERSONA_A" });
    const agentId = created.agent.id;
    const ask = async (sessionId: string, text: string) => {
      const target = { agentId, sessionId };
      const since = model.requests.length;
      await client.sessions.submit({ ...target, text, operationId: crypto.randomUUID() });
      await vi.waitFor(async () => {
        const messages = (await client.sessions.history(target)).entries.flatMap(
          (entry) => entry.model ?? [],
        );
        const user = messages.findLastIndex(
          (message) => message.role === "user" && message.content === text,
        );
        expect(user).toBeGreaterThanOrEqual(0);
        expect(
          messages
            .slice(user + 1)
            .some((message) => message.role === "assistant" && message.stopReason === "stop"),
        ).toBe(true);
        expect(
          (await client.sessions.list({ agentId })).find(({ id }) => id === sessionId)?.busy,
        ).toBe(false);
        expect(model.requests.length).toBeGreaterThan(since);
      }, WAIT);
      return JSON.stringify(
        model.requests.at(-1)?.messages.filter(({ role }) => role === "system"),
      );
    };

    await ask(created.sessionId, `${setSkillDescription}SKILL_A`);
    await client.agents.saveMemory({ agentId, memory: "MEMORY_A" });
    const frozen = await client.sessions.create({ agentId });
    const { version } = await client.agents.persona({ agentId });
    await client.agents.savePersona({ agentId, persona: "PERSONA_B", expectedVersion: version });
    await client.agents.saveMemory({ agentId, memory: "MEMORY_B" });
    await ask(created.sessionId, `${setSkillDescription}SKILL_B`);
    await client.computer.revoke({ deviceId: oldComputer });
    await pair("context-new", "New Computer");

    const root = await ask(created.sessionId, "Check default Session");
    expect(root).toContain("PERSONA_A");
    expect(root).toContain("context-old (Old Computer)");
    expect(root).toContain("<memory>\\n\\n</memory>");
    expect(root).not.toContain("<available_skills>");

    const original = await ask(frozen.id, "Check frozen Session");
    expect(original).toContain("PERSONA_A");
    expect(original).toContain("MEMORY_A");
    expect(original).toContain("context-old (Old Computer)");
    expect(original).toContain("<description>SKILL_A</description>");
    expect(original).not.toContain("PERSONA_B");

    const fresh = await client.sessions.create({ agentId });
    const latest = await ask(fresh.id, "Check fresh Session");
    expect(latest).toContain("<persona>\\nPERSONA_B\\n</persona>");
    expect(latest).toContain("<memory>\\nMEMORY_B\\n</memory>");
    expect(latest).not.toContain("<rules>");
    expect(latest).toContain("context-new (New Computer)");
    expect(latest).toContain("<description>SKILL_B</description>");

    await appendMessage(agentId, frozen.id, "user", "A previous long exchange.");
    await appendMessage(agentId, frozen.id, "assistant", "archive ".repeat(15000));
    await appendMessage(agentId, frozen.id, "user", "A recent exchange to retain.");
    const bindings = env as unknown as Env;
    const stub = bindings.AGENTS.getByName(agentId);
    await runInDurableObject(stub, async (instance) => {
      const pi = await instance.harness.pi();
      const conversation = await instance.harness.conversation(frozen.id);
      const task = await conversation.compact(undefined, BG);
      const receipt = await pi.waitForTask(task, BG);
      expect(receipt.state.outcome.status).toBe("completed");
      await vi.waitFor(
        async () => expect(CompactionEntry.is((await conversation.context(BG)).head!)).toBe(true),
        WAIT,
      );
    });

    await runInDurableObject(bindings.DEPLOYMENT.getByName("deployment"), (instance) => {
      const prototype = Object.getPrototypeOf(instance) as typeof instance;
      vi.spyOn(prototype, "listComputers").mockImplementationOnce(() => {
        throw new Error("Computer directory is temporarily unavailable.");
      });
    });
    const failedText = "Check while the directory is unavailable";
    const operationId = crypto.randomUUID();
    const since = model.requests.length;
    await client.sessions.submit({ agentId, sessionId: frozen.id, text: failedText, operationId });
    const settlement = await runInDurableObject(stub, async (instance) => {
      const pi = await instance.harness.pi();
      const conversation = await instance.harness.conversation(frozen.id);
      const record = await conversation.commit(
        (tx) => tx.submissionByRequest(conversation.id, operationId),
        BG,
      );
      if (!record) throw new Error("Missing submitted input");
      const submission = await pi.submission(record.id, BG);
      if (!submission) throw new Error("Missing submission handle");
      return submission.wait(BG);
    });
    expect(settlement).toMatchObject({
      status: "unanswered",
      reason: "model_error",
      detail: 'Missing prompt section "persona".',
    });
    expect(
      model.requests
        .slice(since)
        .some(({ messages }) =>
          messages.some(({ role, content }) => role === "user" && content === failedText),
        ),
    ).toBe(false);
    expect((await client.sessions.list({ agentId })).find(({ id }) => id === frozen.id)?.busy).toBe(
      false,
    );
    const refreshed = await ask(frozen.id, "Check after the directory recovers");
    expect(refreshed).toBe(latest);
    await client.agents.saveMemory({ agentId, memory: "MEMORY_C" });
    expect(await ask(frozen.id, "Check ordinary request again")).toBe(refreshed);
    const history = await client.sessions.history({ agentId, sessionId: frozen.id });
    expect(history.entries.filter(SystemEntry.is).at(-1)?.model?.[0]).toMatchObject({
      role: "system",
      sections: {
        persona: "<persona>\nPERSONA_B\n</persona>",
        memory: "<memory>\nMEMORY_B\n</memory>",
      },
    });
  });

  it("rejects a missing section even after a previous complete request", async () => {
    const { client, login } = owner();
    await login();
    const { agent, sessionId } = await createAgent(client, {
      name: "Section errors",
      persona: "",
    });
    const model = modelFixture(() => ({ text: "Ready." }));
    await client.sessions.submit({
      agentId: agent.id,
      sessionId,
      text: "First request",
      operationId: crypto.randomUUID(),
    });
    await vi.waitFor(async () => {
      expect(
        JSON.stringify((await client.sessions.history({ agentId: agent.id, sessionId })).entries),
      ).toContain("Ready.");
      expect(
        (await client.sessions.list({ agentId: agent.id })).find(({ id }) => id === sessionId)
          ?.busy,
      ).toBe(false);
    }, WAIT);
    const bindings = env as unknown as Env;
    const stub = bindings.AGENTS.getByName(agent.id);
    const settlement = await runInDurableObject(stub, async (instance) => {
      const conversation = await instance.harness.conversation(sessionId);
      const context = await conversation.context(BG);
      expect(context.messages.some((message) => message.role === "system")).toBe(true);
      const section = (await conversation.agent(BG)).sections.find(({ key }) => key === "memory");
      if (!section) throw new Error("Missing memory section");
      vi.spyOn(section, "render").mockResolvedValueOnce(undefined);
      const failed = await conversation.submit({ type: "input", content: "Second request" }, BG);
      return failed.wait(BG);
    });
    expect(settlement).toMatchObject({
      status: "unanswered",
      reason: "model_error",
      detail: 'Missing prompt section "memory".',
    });
    expect(
      model.requests.some(({ messages }) =>
        messages.some(({ role, content }) => role === "user" && content === "Second request"),
      ),
    ).toBe(false);
    expect(
      (await client.sessions.list({ agentId: agent.id })).find(({ id }) => id === sessionId)?.busy,
    ).toBe(false);
  });

  it("captures the shared files when an Automation creates its model Session", async () => {
    const { client, login } = owner();
    await login();
    const created = await createAgent(client, {
      name: "Automation context",
      persona: "AUTOMATION_PERSONA",
    });
    const agentId = created.agent.id;
    await client.agents.saveMemory({ agentId, memory: "AUTOMATION_MEMORY" });
    const model = modelFixture(() => ({ text: "Automation context reply." }));
    const automation = await client.automations.create({
      agentId,
      id: crypto.randomUUID(),
      definition: {
        name: "Context capture",
        timezone: "UTC",
        trigger: automationTriggerSoon(),
        enabled: true,
        script: "return {runAgent:true};",
        prompt: "Use the Automation context.",
      },
    });
    await vi.waitFor(async () => {
      const { runs } = await client.automations.history({ agentId, id: automation.id });
      expect(runs[0]?.status).toBe("succeeded");
    }, WAIT);
    const system = JSON.stringify(
      model.requests.at(-1)?.messages.filter(({ role }) => role === "system"),
    );
    expect(system).toContain("AUTOMATION_PERSONA");
    expect(system).toContain("<memory>\\nAUTOMATION_MEMORY\\n</memory>");
  });

  it("renames, archives and restores without changing native history and survives eviction", async () => {
    const session = owner();
    await session.login();
    const created = await createAgent(session.client, { name: "History", persona: "" });
    const target = { agentId: created.agent.id, sessionId: created.sessionId };
    const id = await appendMessage(
      target.agentId,
      target.sessionId,
      "user",
      "Archive this durable note.",
    );
    await session.client.sessions.update({ ...target, title: "Research notes", archived: true });
    expect(await session.client.sessions.list({ agentId: target.agentId })).toHaveLength(0);
    const bindings = env as unknown as Env;
    await evictDurableObject(bindings.AGENTS.get(bindings.AGENTS.idFromName(target.agentId)));
    expect(
      await session.client.sessions.list({ agentId: target.agentId, archived: true }),
    ).toMatchObject([{ id: target.sessionId, title: "Research notes", archived: true }]);
    expect(
      (await session.client.sessions.history(target)).entries.some(
        (entry) => Number(entry.id) === id,
      ),
    ).toBe(true);
    await session.client.sessions.update({ ...target, archived: false });
    expect(await session.client.sessions.list({ agentId: target.agentId })).toMatchObject([
      { title: "Research notes", archived: false },
    ]);
  });
  it("searches Chinese short/long terms and English across archived Sessions, then rebuilds", async () => {
    const session = owner();
    await session.login();
    const first = await createAgent(session.client, { name: "Search", persona: "" });
    const second = await createAgent(session.client, { name: "Private other Agent", persona: "" });
    const target = { agentId: first.agent.id, sessionId: first.sessionId };
    await appendMessage(target.agentId, target.sessionId, "user", "Before the preference");
    const entryId = await appendMessage(
      target.agentId,
      target.sessionId,
      "assistant",
      "用户的长期记忆：喜欢茉莉花茶。The project is called Silver Orchard.",
    );
    await appendMessage(target.agentId, target.sessionId, "user", "After the preference");
    await appendMessage(
      second.agent.id,
      second.sessionId,
      "user",
      "Silver Orchard private-other-agent",
    );
    await session.client.sessions.update({ ...target, archived: true });
    for (const query of ["长期记忆", "花茶", "茶", "Silver Orchard"]) {
      const results = await session.client.sessions.search({ agentId: target.agentId, query });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ sessionId: target.sessionId, entryId, archived: true });
      expect(JSON.stringify(results[0].context)).toContain("Before the preference");
      expect(JSON.stringify(results[0].context)).toContain("After the preference");
    }
    await session.client.sessions.rebuildIndex({ agentId: target.agentId });
    expect(
      await session.client.sessions.search({ agentId: target.agentId, query: "花茶" }),
    ).toHaveLength(1);
  });
});
