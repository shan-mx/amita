import { createAgent } from "./helpers";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { codemodeToolCall, owner, modelFixture, WAIT } from "./helpers";
afterEach(() => vi.restoreAllMocks());

it.each([
  { arguments: { action: "get" }, field: "id" },
  { arguments: { action: "run" }, field: "action" },
  {
    arguments: { action: "create", job: { trigger: { type: "cron", expression: "0 9 * * *" } } },
    field: "job.name",
  },
])(
  "tells the model which automation field is invalid ($field)",
  async ({ arguments: args, field }) => {
    const model = modelFixture(({ messages }) =>
      messages.some(({ role }) => role === "tool")
        ? { text: "Automation error received." }
        : { tool: codemodeToolCall("automation", args) },
    );
    const { client, login } = owner();
    await login();
    const { agent, sessionId } = await createAgent(client, {
      name: "Automation validation",
      persona: "",
    });
    await client.sessions.submit({
      agentId: agent.id,
      sessionId,
      operationId: crypto.randomUUID(),
      text: "Use the requested automation.",
    });
    await vi.waitFor(() => {
      const toolResults = model.requests.flatMap(({ messages }) =>
        messages.filter(({ role }) => role === "tool"),
      );
      const output = JSON.stringify(toolResults);
      expect(output).toContain(field === "action" ? "action" : `${field}:`);
    }, WAIT);
  },
);

it("creates automations from chat using the submitted browser time zone", async () => {
  const model = modelFixture(({ messages }) =>
    messages.some((message) => message.role === "tool")
      ? { text: "AUTOMATION_CREATED_IN_CHAT" }
      : {
          tool: codemodeToolCall("automation", {
            action: "create",
            job: {
              name: "Chat automation",
              trigger: { type: "cron", expression: "0 9 * * 1-5" },
              prompt: "Check the current conversation.",
              execution: { kind: "existing_session", sessionId: "current" },
              enabled: false,
            },
          }),
        },
  );
  const account = owner();
  await account.login();
  const created = await createAgent(account.client, {
    name: "Chat automation fixture",
    persona: "",
  });
  const f = { account, created, agentId: created.agent.id, api: account.client.automations };
  await f.account.client.sessions.submit({
    agentId: f.agentId,
    sessionId: f.created.sessionId,
    operationId: crypto.randomUUID(),
    text: "Create the automation.",
    timezone: "Asia/Taipei",
  });
  await vi.waitFor(async () => {
    const automations = await f.api.list({ agentId: f.agentId });
    expect(automations).toHaveLength(1);
    expect(automations[0].definition).toMatchObject({
      name: "Chat automation",
      timezone: "Asia/Taipei",
      enabled: false,
      execution: { kind: "existing_session", sessionId: f.created.sessionId },
    });
  }, WAIT);
  const request = model.requests[0];
  expect(request.tools?.map(({ function: tool }) => tool.name).sort()).toEqual([
    "bash",
    "codemode",
    "fs_read",
  ]);
  const codemode = request.messages
    .filter(({ role }) => role === "system")
    .map(({ content }) => content)
    .join("\n")
    .match(/<codemode>\n([\s\S]*?)\n<\/codemode>/)?.[1];
  expect(codemode).toContain("### `automation`");
  expect(codemode).toContain(
    "When paired with a prompt, return {runAgent: boolean, context?: JSON}.",
  );
  expect(codemode).toContain("### `fs_mkdir`");
  expect(codemode).toContain("Create missing parent directories.");
});
