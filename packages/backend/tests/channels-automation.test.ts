import { afterEach, expect, it, vi } from "vite-plus/test";
import { agent, pairingCommand, telegram, listDestinations } from "./channels-fixture";
import { automationTriggerSoon, WAIT } from "./helpers";

afterEach(() => vi.restoreAllMocks());

it("lets an isolated automation send through the ordinary tool without automatic result forwarding", async () => {
  let destinationId = "";
  const fixture = telegram({
    model: ({ messages }) => {
      if (messages.some(({ role }) => role === "tool")) return { text: "NO_REPLY" };
      return {
        tool: { name: "channel_send", arguments: { destinationId, text: "Scheduled report" } },
      };
    },
  });
  const { client, agentId } = await agent();
  const { id } = await client.channels.connect({ agentId, token: "360:fixture" });
  const link = await client.channels.pair({ agentId, id });
  await fixture.send(id, 1, pairingCommand(link.url));
  const destinations = await listDestinations(client, agentId);
  destinationId = destinations[0].id;
  const automation = await client.automations.create({
    agentId,
    id: crypto.randomUUID(),
    definition: {
      name: "Scheduled report",
      timezone: "UTC",
      trigger: automationTriggerSoon(),
      prompt: `Send the report using channel_send to ${destinationId}.`,
    },
  });
  let sessionId: string | undefined;
  await vi.waitFor(async () => {
    const { runs } = await client.automations.history({ agentId, id: automation.id });
    expect(runs[0]?.status).toBe("succeeded");
    sessionId = runs[0]?.sessionId;
  }, WAIT);
  expect(fixture.outbound).toEqual([expect.objectContaining({ text: "Scheduled report" })]);
  expect(sessionId).toBeDefined();
  const history = await client.sessions.history({ agentId, sessionId: sessionId! });
  expect(JSON.stringify(history)).toContain("NO_REPLY");
  expect(JSON.stringify(history)).toContain("channel_send");
});
