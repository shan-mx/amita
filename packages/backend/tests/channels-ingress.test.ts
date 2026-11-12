import { env, evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { Env } from "../src/env";
import { Inbound } from "../src/channels/state";
import { WAIT } from "./helpers";
import { telegram, agent, pairingCommand, listDestinations } from "./channels-fixture";

afterEach(() => vi.restoreAllMocks());

it("keeps the verified webhook available if Telegram rejects command registration", async () => {
  const fixture = telegram();
  const upstream = vi.mocked(fetch).getMockImplementation()!;
  vi.spyOn(globalThis, "fetch").mockImplementation((resource, init) => {
    const url = new URL(new Request(resource, init).url);
    if (url.hostname === "api.telegram.org" && url.pathname.endsWith("/setMyCommands"))
      return Promise.resolve(Response.json({ ok: false, error_code: 429 }, { status: 429 }));
    return upstream(resource, init);
  });
  const { client, agentId } = await agent();
  const { id, webhookReady } = await client.channels.connect({
    agentId,
    token: "121:fixture",
  });
  expect(webhookReady).toBe(true);
  const link = await client.channels.pair({ agentId, id });
  expect((await fixture.send(id, 1, pairingCommand(link.url))).status).toBe(200);
});

it("pairs a Bot and replies once to a Telegram update across Agent restarts", async () => {
  const fixture = telegram();
  const { client, agentId } = await agent();
  const before = await client.sessions.list({ agentId });
  const connection = await client.channels.connect({
    agentId,
    token: "123:fixture",
  });
  expect(connection).toMatchObject({ platform: "telegram", status: "pairing", webhookReady: true });
  const pair = await client.channels.pair({ agentId, id: connection.id });
  const command = pairingCommand(pair.url);
  expect((await fixture.send(connection.id, 1, command)).status).toBe(200);
  expect((await fixture.send(connection.id, 1, command)).status).toBe(200);
  expect((await client.channels.list({ agentId })).connections[0]?.status).toBe("connected");
  expect((await fixture.send(connection.id, 2, "Hello from Telegram")).status).toBe(200);
  await vi.waitFor(
    () =>
      expect(fixture.outbound).toContainEqual(
        expect.objectContaining({ text: "TELEGRAM\\_ANSWER" }),
      ),
    WAIT,
  );
  const stub = (env as unknown as Env).AGENTS.getByName(agentId);
  await vi.waitFor(async () => {
    const tasks = await runInDurableObject(stub, async (instance) =>
      (await instance.harness.pi()).commit((tx) => tx.scanTasks({}, 30), BG),
    );
    expect(tasks.items.every((task) => task.state.status === "terminal")).toBe(true);
  }, WAIT);
  await evictDurableObject(stub);
  expect((await fixture.send(connection.id, 2, "Hello from Telegram")).status).toBe(200);
  expect((await client.sessions.list({ agentId })).length).toBe(before.length + 1);
  expect(fixture.model.requests).toHaveLength(1);
  expect(fixture.outbound.filter((item) => item.text === "TELEGRAM\\_ANSWER")).toEqual([
    expect.objectContaining({ chat_id: 991 }),
  ]);
  const readInbox = () =>
    runInDurableObject(stub, async (instance) =>
      (await instance.harness.pi()).snapshot(Inbound, connection.id, BG),
    );
  const updateKey = `${connection.id}:2`;
  const receipt = await readInbox();
  expect(receipt?.pending).toEqual({});
  const expiresAt = receipt?.recent[updateKey];
  expect(expiresAt).toBeTypeOf("number");
  const clock = vi.spyOn(Date, "now").mockReturnValue(expiresAt! + 1);
  try {
    expect((await fixture.send(connection.id, 3, "New Telegram update")).status).toBe(200);
    await vi.waitFor(async () => {
      const inbox = await readInbox();
      expect(inbox?.pending).toEqual({});
      expect(Object.keys(inbox?.recent ?? {})).toEqual([`${connection.id}:3`]);
    }, WAIT);
    await vi.waitFor(() => expect(fixture.outbound).toHaveLength(2), WAIT);
  } finally {
    clock.mockRestore();
  }
  expect(fixture.model.requests).toHaveLength(2);
});

it("allows only the bound Owner to pair another Bot ", async () => {
  const fixture = telegram();
  const { client, agentId } = await agent();
  const a = await client.channels.connect({
    agentId,
    token: "123:fixture",
  });
  const b = await client.channels.connect({
    agentId,
    token: "124:fixture",
  });
  const [first, second] = await Promise.all([
    client.channels.pair({ agentId, id: a.id }),
    client.channels.pair({ agentId, id: b.id }),
  ]);
  const sessions = await client.sessions.list({ agentId });
  const unauthenticated = await SELF.fetch(`https://amita.test/webhooks/telegram/${a.id}`, {
    method: "POST",
  });
  expect(unauthenticated.status).toBe(403);
  expect((await fixture.send(a.id, 1, "/start invalid-code")).status).toBe(200);
  expect((await client.channels.list({ agentId })).ownerLinked).toBe(false);
  const results = await Promise.all([
    fixture.send(a.id, 2, pairingCommand(first.url), 991),
    fixture.send(b.id, 2, pairingCommand(second.url), 992),
  ]);
  expect(results.map((result) => result.status)).toEqual([200, 200]);
  const { connections } = await client.channels.list({ agentId });
  expect(connections.map(({ status }) => status).sort()).toEqual(["connected", "pairing"]);
  const loser = connections.find(({ status }) => status === "pairing")!;
  const winner = loser.id === a.id ? b : a;
  const otherUser = loser.id === a.id ? 991 : 992;
  expect((await fixture.send(winner.id, 3, "Unapproved input", otherUser)).status).toBe(200);
  const group = await fixture.send(winner.id, 4, {
    chat: { id: -1001, type: "group" },
    text: "Group input",
  });
  expect(group.status).toBe(200);
  expect(await client.sessions.list({ agentId })).toEqual(sessions);
  expect(fixture.model.requests).toHaveLength(0);
  const destinations = await listDestinations(client, agentId);
  expect(destinations).toHaveLength(1);
});

it("rolls back the first Owner binding if the connection update fails", async () => {
  const fixture = telegram();
  const { client, agentId } = await agent();
  const { id } = await client.channels.connect({
    agentId,
    token: "125:fixture",
  });
  const link = await client.channels.pair({ agentId, id });
  const deployment = (env as unknown as Env).DEPLOYMENT.getByName("deployment");
  await runInDurableObject(deployment, (_instance, state) => {
    state.storage.sql.exec(`CREATE TRIGGER reject_channel_pair BEFORE UPDATE ON channel_connection
      BEGIN SELECT RAISE(ABORT, 'pairing update interrupted'); END`);
  });
  try {
    expect((await fixture.send(id, 1, pairingCommand(link.url))).status).toBe(500);
    expect(await client.channels.list({ agentId })).toMatchObject({
      ownerLinked: false,
      connections: [{ id, status: "pairing" }],
    });
  } finally {
    await runInDurableObject(deployment, (_instance, state) => {
      state.storage.sql.exec("DROP TRIGGER reject_channel_pair");
    });
  }
  expect((await fixture.send(id, 1, pairingCommand(link.url))).status).toBe(200);
  expect(await client.channels.list({ agentId })).toMatchObject({
    ownerLinked: true,
    connections: [{ id, status: "connected" }],
  });
});

it("keeps the existing Telegram conversation model after the Agent model changes", async () => {
  const fixture = telegram();
  const { client, agentId } = await agent();
  const { id } = await client.channels.connect({
    agentId,
    token: "126:fixture",
  });
  const link = await client.channels.pair({ agentId, id });
  expect((await fixture.send(id, 1, pairingCommand(link.url))).status).toBe(200);
  expect((await fixture.send(id, 2, "First turn")).status).toBe(200);
  await vi.waitFor(() => expect(fixture.outbound).toHaveLength(1), WAIT);
  const selected = (await client.providers.models()).find(({ id }) => id === "deepseek-v4-pro");
  if (!selected) throw new Error("Missing fixture model");
  await client.agents.setModel({
    agentId,
    model: { provider: selected.provider, modelId: selected.id },
  });
  expect((await fixture.send(id, 3, "Second turn")).status).toBe(200);
  await vi.waitFor(() => expect(fixture.outbound).toHaveLength(2), WAIT);
  expect(fixture.model.requests.map(({ model }) => model)).toEqual([
    "deepseek-flash",
    "deepseek-flash",
  ]);
});

it("rejects disconnect during setup before changing the connection", async () => {
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  let releaseSetup!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseSetup = resolve;
  });
  const fixture = telegram({
    beforeWebhookWrite: (botId) => {
      if (botId !== 127) return;
      signalEntered();
      return release;
    },
  });
  const { client, agentId } = await agent();
  const connecting = client.channels.connect({
    agentId,
    token: "127:fixture",
  });
  await entered;
  const { id } = (await client.channels.list({ agentId })).connections[0];
  try {
    await expect(client.channels.disconnect({ agentId, id })).rejects.toThrow(
      "already in progress",
    );
    expect((await client.channels.list({ agentId })).connections[0]?.status).not.toBe(
      "disconnected",
    );
  } finally {
    releaseSetup();
  }
  await connecting;
  await client.channels.disconnect({ agentId, id });
  expect(fixture.webhooks.get("bot127:fixture")).toBeUndefined();
});
