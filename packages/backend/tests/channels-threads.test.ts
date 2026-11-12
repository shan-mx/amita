import { afterEach, expect, it, vi } from "vite-plus/test";
import { agent, pairingCommand, telegram, listDestinations } from "./channels-fixture";
import { WAIT } from "./helpers";

afterEach(() => vi.restoreAllMocks());

it("routes existing topics independently and /new changes only the selected conversation", async () => {
  const fixture = telegram();
  const { client, agentId } = await agent();
  const { id } = await client.channels.connect({
    agentId,
    token: "250:fixture",
  });
  const link = await client.channels.pair({ agentId, id });
  await fixture.send(id, 1, pairingCommand(link.url));
  await Promise.all([
    fixture.send(id, 2, "Topic A", 991, 100),
    fixture.send(id, 3, "Topic B", 991, 200),
  ]);
  await vi.waitFor(
    () =>
      expect(fixture.outbound.map(({ message_thread_id }) => message_thread_id)).toEqual(
        expect.arrayContaining([100, 200]),
      ),
    WAIT,
  );
  const before = await client.sessions.list({ agentId });
  await fixture.send(id, 4, "/new", 991, 100);
  await vi.waitFor(
    () =>
      expect(fixture.outbound).toContainEqual(
        expect.objectContaining({
          message_thread_id: 100,
          text: expect.stringContaining("Started a new conversation"),
        }),
      ),
    WAIT,
  );
  const after = await client.sessions.list({ agentId });
  expect(after).toHaveLength(before.length + 1);
  const fresh = after.find(({ id }) => !before.some((session) => session.id === id));
  expect(fresh?.title).toBe("New session");
  const histories = await Promise.all(
    after.map(({ id: sessionId }) => client.sessions.history({ agentId, sessionId })),
  );
  const inputs = histories.flatMap(({ entries }) =>
    entries.flatMap(({ model }) => model ?? []).filter(({ role }) => role === "user"),
  );
  expect(inputs.filter(({ content }) => content === "Topic A")).toHaveLength(1);
  expect(inputs.filter(({ content }) => content === "Topic B")).toHaveLength(1);
  await fixture.send(id, 5, "Continue A", 991, 100);
  await fixture.send(id, 6, "Continue B", 991, 200);
  await vi.waitFor(() => expect(fixture.outbound).toHaveLength(5), WAIT);
  const requests = fixture.model.requests.map((request) => JSON.stringify(request));
  const continuedA = requests.find((request) => request.includes("Continue A"));
  const continuedB = requests.find((request) => request.includes("Continue B"));
  expect(continuedA).toBeDefined();
  expect(continuedA).not.toContain("Topic A");
  expect(continuedB).toContain("Topic B");
  await vi.waitFor(async () => {
    const sessions = await client.sessions.list({ agentId });
    expect(sessions.find(({ id }) => id === fresh?.id)?.title).toBe("Fixture session title");
  }, WAIT);
  await fixture.send(id, 7, { forum_topic_edited: { name: "Renamed Topic" } }, 991, 100);
  await vi.waitFor(async () => {
    const destinations = await listDestinations(client, agentId);
    expect(destinations?.some(({ label }) => label.endsWith("/ Renamed Topic"))).toBe(true);
  }, WAIT);
  const sessions = await client.sessions.list({ agentId });
  expect(sessions.find(({ id }) => id === fresh?.id)?.title).toBe("Fixture session title");
});

it("creates a new topic for main-chat requests when the Bot supports threads", async () => {
  const fixture = telegram({ topicsEnabled: () => true });
  const { client, agentId } = await agent();
  const { id } = await client.channels.connect({
    agentId,
    token: "251:fixture",
  });
  const link = await client.channels.pair({ agentId, id });
  await fixture.send(id, 1, pairingCommand(link.url));
  await fixture.send(id, 3, "Create a topic for this");
  await vi.waitFor(
    () =>
      expect(fixture.outbound).toContainEqual(
        expect.objectContaining({
          message_thread_id: 500,
          text: expect.stringContaining("TELEGRAM"),
        }),
      ),
    WAIT,
  );
  const sessions = await client.sessions.list({ agentId });
  const histories = await Promise.all(
    sessions.map(({ id: sessionId }) => client.sessions.history({ agentId, sessionId })),
  );
  const inputs = histories.flatMap(({ entries }) =>
    entries.flatMap(({ model }) => model ?? []).filter(({ role }) => role === "user"),
  );
  expect(inputs.filter(({ content }) => content === "Create a topic for this")).toHaveLength(1);
  await vi.waitFor(
    () =>
      expect(fixture.calls).toContainEqual({
        method: "editForumTopic",
        body: { chat_id: 991, message_thread_id: 500, name: "Fixture session title" },
      }),
    WAIT,
  );
  await vi.waitFor(async () => {
    const targets = await listDestinations(client, agentId);
    expect(targets.some(({ label }) => label.endsWith("/ Fixture session title"))).toBe(true);
  }, WAIT);
});

it("continues other topics while a failed topic creation keeps the original input out of Pi", async () => {
  const blockedInput = "This request needs a new topic";
  const acceptedInput = "Existing topic stays usable";
  let markStarted!: () => void;
  let releaseRequest!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  const fixture = telegram({
    topicsEnabled: () => true,
    createTopic: async () => {
      markStarted();
      await pending;
      return Response.json(
        {
          ok: false,
          error_code: 400,
          description: "Bad Request: not enough rights to create a topic",
        },
        { status: 400 },
      );
    },
  });
  const { client, agentId } = await agent();
  const { id } = await client.channels.connect({
    agentId,
    token: "252:fixture",
  });
  const link = await client.channels.pair({ agentId, id });
  await fixture.send(id, 1, pairingCommand(link.url));
  await fixture.send(id, 3, blockedInput);
  await started;
  try {
    await fixture.send(id, 4, acceptedInput, 991, 300);
    await vi.waitFor(
      () =>
        expect(fixture.outbound).toContainEqual(
          expect.objectContaining({
            message_thread_id: 300,
            text: expect.stringContaining("TELEGRAM"),
          }),
        ),
      WAIT,
    );
  } finally {
    releaseRequest();
  }
  await vi.waitFor(
    () =>
      expect(fixture.outbound).toContainEqual(
        expect.objectContaining({ text: expect.stringContaining("Your request has not started") }),
      ),
    WAIT,
  );
  const sessions = await client.sessions.list({ agentId });
  const histories = await Promise.all(
    sessions.map(({ id: sessionId }) => client.sessions.history({ agentId, sessionId })),
  );
  const inputs = histories.flatMap(({ entries }) =>
    entries.flatMap(({ model }) => model ?? []).filter(({ role }) => role === "user"),
  );
  expect(inputs.filter(({ content }) => content === acceptedInput)).toHaveLength(1);
  expect(inputs.some(({ content }) => content === blockedInput)).toBe(false);
  expect(
    fixture.model.requests.some(({ messages }) =>
      messages.some(({ role, content }) => role === "user" && content === blockedInput),
    ),
  ).toBe(false);
  expect(
    fixture.outbound.some(({ text }) =>
      String(text).includes("not enough rights to create a topic"),
    ),
  ).toBe(true);
});
