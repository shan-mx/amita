import { COMPANION_PROTOCOL } from "../src/shared/companion";
import { SELF } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { agent, pairingCommand, telegram } from "./channels-fixture";
import { WAIT } from "./helpers";

afterEach(() => vi.restoreAllMocks());

it("places captioned and attachment-only inputs in Pi without downloading platform files", async () => {
  const fixture = telegram();
  const { client, agentId } = await agent();
  const before = new Set((await client.sessions.list({ agentId })).map(({ id }) => id));
  const { id } = await client.channels.connect({
    agentId,
    token: "350:fixture",
  });
  const link = await client.channels.pair({ agentId, id });
  await fixture.send(id, 1, pairingCommand(link.url));
  const document = {
    caption: "Summarize this report",
    quote: { text: "Selected reply excerpt" },
    reply_to_message: {
      message_id: 91,
      date: 1,
      chat: { id: 991, type: "private" },
      caption: "Original media caption",
    },
    document: {
      file_id: "private-doc-locator",
      file_name: "report.pdf",
      mime_type: "application/pdf",
      file_size: 1200,
    },
  };
  expect((await fixture.send(id, 2, document, 991, 100)).status).toBe(200);
  expect((await fixture.send(id, 2, document, 991, 100)).status).toBe(200);
  await vi.waitFor(() => expect(fixture.outbound).toHaveLength(1), WAIT);
  await fixture.send(id, 4, {
    photo: [
      { file_id: "private-small-photo", width: 20, height: 20, file_size: 100 },
      { file_id: "private-large-photo", width: 40, height: 40, file_size: 540 },
    ],
  });
  await vi.waitFor(() => expect(fixture.outbound).toHaveLength(2), WAIT);

  expect(fixture.model.requests).toHaveLength(2);
  const [report, image] = fixture.model.requests.map((request) => JSON.stringify(request));
  expect(report).toMatch(/Selected reply excerpt.*Summarize this report/);
  expect(report).not.toContain("Original media caption");
  expect(report).toMatch(/Summarize this report.*report\.pdf.*application\/pdf.*1200 bytes/);
  expect(image).toMatch(/photo\.jpg.*image\/jpeg.*540 bytes/);
  expect(report).toMatch(/attachmentId [a-f0-9-]{36}/);
  expect(image).toMatch(/attachmentId [a-f0-9-]{36}/);
  expect(report.match(/attachmentId ([a-f0-9-]{36})/)?.[1]).not.toBe(
    image.match(/attachmentId ([a-f0-9-]{36})/)?.[1],
  );
  expect(report).not.toContain("private-doc-locator");
  expect(image).not.toContain("private-large-photo");
  expect(fixture.calls.filter(({ method }) => method === "getFile")).toEqual([]);

  const sessions = (await client.sessions.list({ agentId })).filter(({ id }) => !before.has(id));
  expect(sessions).toHaveLength(2);
  const history = await Promise.all(
    sessions.map(({ id: sessionId }) => client.sessions.history({ agentId, sessionId })),
  );
  const [first, second] = history.map((page) => JSON.stringify(page)).sort();
  expect([first, second].filter((page) => page.includes("report.pdf"))).toHaveLength(1);
  expect([first, second].filter((page) => page.includes("photo.jpg"))).toHaveLength(1);
  expect([first, second].join("")).toContain(
    '"replyTo":{"messageId":"91","text":"Selected reply excerpt"}',
  );
  expect([first, second].join("")).not.toContain("private-");
});

it("imports Telegram bytes through a native Pi tool call and the selected Companion", async () => {
  const bytes = Uint8Array.from({ length: 140_000 }, (_, index) => index % 251);
  const version =
    "sha256:" +
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  const computer = "download-fixture-" + crypto.randomUUID().slice(0, 8);
  let receivedAttachmentId: string | undefined;
  let failSource = false;
  const fixture = telegram({
    file: () =>
      failSource
        ? new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("Source stream failed."));
              },
            }),
          )
        : new Response(bytes),
    model: ({ messages }) => {
      if (messages.some(({ role }) => role === "tool")) return { text: "Download finished" };
      const transcript = JSON.stringify(messages);
      const attachmentId = transcript.includes("Try the attachment from another session")
        ? receivedAttachmentId
        : /attachmentId ([a-f0-9-]{36})/.exec(transcript)?.[1];
      if (!attachmentId) return { text: "Missing attachment" };
      receivedAttachmentId = attachmentId;
      return { tool: { name: "channel_download", arguments: { attachmentId, computer } } };
    },
  });
  const { client, agentId } = await agent();
  const registration = await client.computer.registration();
  const registered = await SELF.fetch("https://amita.test/api/companion/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: registration.code, name: "Download fixture" }),
  });
  const device = await registered.json<{ deviceId: string; credential: string }>();
  await client.computer.confirm({ deviceId: device.deviceId, slug: computer });
  const connected = await SELF.fetch("https://amita.test/api/companion/connect", {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${device.credential}` },
  });
  const socket = connected.webSocket!;
  socket.accept();
  const imported = new Uint8Array(bytes.length);
  const chunks: number[] = [];
  const methods: string[] = [];
  let publishPath: string | undefined;
  let ready = false;
  const streams = new Map<
    string,
    { path: string; cwd: string; transferId: string; size: number }
  >();
  socket.addEventListener("message", ({ data }) => {
    const frame = JSON.parse(String(data));
    if (frame.type === "ready") ready = true;
    if (frame.type === "file_request") {
      methods.push(frame.method);
      if (frame.method === "importFile") {
        streams.set(frame.id, { ...frame.params, size: 0 });
      } else
        socket.send(
          JSON.stringify({ type: "file_result", id: frame.id, result: { ok: true, value: null } }),
        );
    }
    if (frame.type === "file_chunk") {
      const stream = streams.get(frame.id)!;
      const data = Uint8Array.from(atob(frame.content), (byte) => byte.charCodeAt(0));
      chunks.push(stream.size);
      imported.set(data, stream.size);
      stream.size += data.length;
    }
    if (frame.type === "file_end") {
      const stream = streams.get(frame.id)!;
      socket.send(
        JSON.stringify({
          type: "file_result",
          id: frame.id,
          result: {
            ok: true,
            value: {
              path: (publishPath = `${stream.cwd}/${stream.path}`),
              size: stream.size,
              version,
            },
          },
        }),
      );
      streams.delete(frame.id);
    }
  });
  socket.send(
    JSON.stringify({
      type: "hello",
      protocol: COMPANION_PROTOCOL,
      name: "Download fixture",
      cwd: "/fixture",
      home: "/fixture",
      os: "darwin",
    }),
  );
  try {
    await vi.waitFor(() => expect(ready).toBe(true), WAIT);
    const before = new Set((await client.sessions.list({ agentId })).map(({ id }) => id));
    const { id } = await client.channels.connect({
      agentId,
      token: "351:fixture",
    });
    const link = await client.channels.pair({ agentId, id });
    await fixture.send(id, 1, pairingCommand(link.url));
    expect(
      (
        await fixture.send(id, 2, {
          caption: "Download this file",
          document: { file_id: "private-file", file_name: "fixture.bin", file_size: bytes.length },
        })
      ).status,
    ).toBe(200);
    await vi.waitFor(() => expect(fixture.outbound.at(-1)?.text).toBe("Download finished"), WAIT);
    const session = (await client.sessions.list({ agentId })).find(({ id }) => !before.has(id))!;
    const { entries } = await client.sessions.history({ agentId, sessionId: session.id });
    const result = entries
      .flatMap(({ model }) => model ?? [])
      .find(({ role }) => role === "toolResult");
    expect(result, JSON.stringify(result?.content)).toMatchObject({ isError: false });
    expect(chunks.at(0)).toBe(0);
    expect(methods.filter((method) => method === "importFile")).toHaveLength(1);
    expect(imported).toEqual(bytes);
    expect(publishPath).toMatch(/attachments\/[a-f0-9-]+\/fixture\.bin$/);
    expect(JSON.stringify(entries)).toContain(version);
    expect(JSON.stringify(entries)).not.toContain("private-file");
    const other = await client.sessions.create({ agentId });
    const otherSession = { agentId, sessionId: other.id };
    await client.sessions.submit({
      ...otherSession,
      operationId: crypto.randomUUID(),
      text: "Try the attachment from another session",
    });
    await vi.waitFor(async () => {
      const history = await client.sessions.history(otherSession);
      const result = history.entries
        .flatMap(({ model }) => model ?? [])
        .find(({ role }) => role === "toolResult");
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toContain("[not_found]");
    }, WAIT);
    expect(fixture.calls.filter(({ method }) => method === "getFile")).toEqual([
      expect.objectContaining({ body: { file_id: "private-file" } }),
    ]);
    const existing = new Set((await client.sessions.list({ agentId })).map(({ id }) => id));
    failSource = true;
    await fixture.send(
      id,
      3,
      {
        caption: "Download the interrupted source",
        document: { file_id: "failed-file", file_name: "failed.bin", file_size: bytes.length },
      },
      991,
      50,
    );
    await vi.waitFor(async () => {
      const failedSession = (await client.sessions.list({ agentId })).find(
        ({ id }) => !existing.has(id),
      );
      if (!failedSession) throw new Error("Waiting for failed download session");
      const { entries } = await client.sessions.history({ agentId, sessionId: failedSession.id });
      const result = entries
        .flatMap(({ model }) => model ?? [])
        .find(({ role }) => role === "toolResult");
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toContain("[unknown]");
    }, WAIT);
  } finally {
    socket.close();
  }
});

it("keeps Telegram file bytes untouched when the selected Computer is offline or the attachment exceeds the limit", async () => {
  const computer = "offline-download-" + crypto.randomUUID().slice(0, 8);
  const fixture = telegram({
    model: ({ messages }) => {
      if (messages.some(({ role }) => role === "tool")) return { text: "Download reported" };
      const attachmentId = /attachmentId ([a-f0-9-]{36})/.exec(JSON.stringify(messages))?.[1];
      return { tool: { name: "channel_download", arguments: { attachmentId, computer } } };
    },
  });
  const { client, agentId } = await agent();
  const registration = await client.computer.registration();
  const registered = await SELF.fetch("https://amita.test/api/companion/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: registration.code, name: "Offline download fixture" }),
  });
  const device = await registered.json<{ deviceId: string }>();
  await client.computer.confirm({ deviceId: device.deviceId, slug: computer });
  const { id } = await client.channels.connect({ agentId, token: "363:fixture" });
  const link = await client.channels.pair({ agentId, id });
  await fixture.send(id, 1, pairingCommand(link.url));
  await fixture.send(
    id,
    2,
    { document: { file_id: "offline-file", file_name: "offline.pdf", file_size: 20 } },
    991,
    600,
  );
  await fixture.send(
    id,
    3,
    {
      document: {
        file_id: "oversized-file",
        file_name: "oversized.pdf",
        file_size: 21 * 1024 * 1024,
      },
    },
    991,
    601,
  );
  await vi.waitFor(
    () =>
      expect(fixture.outbound.filter(({ text }) => text === "Download reported")).toHaveLength(2),
    WAIT,
  );
  const toolReplies = fixture.model.requests.flatMap(({ messages }) =>
    messages.filter(({ role }) => role === "tool"),
  );
  expect(toolReplies.map(({ content }) => JSON.stringify(content))).toEqual(
    expect.arrayContaining([
      expect.stringContaining("[computer_offline]"),
      expect.stringContaining("[too_large]"),
    ]),
  );
  expect(fixture.calls.some(({ method }) => method === "getFile")).toBe(false);
});

it("preserves Telegram formatting and non-text descriptions while excluding animation documents", async () => {
  const fixture = telegram();
  const { client, agentId } = await agent();
  const { id } = await client.channels.connect({ agentId, token: "354:fixture" });
  const link = await client.channels.pair({ agentId, id });
  await fixture.send(id, 1, pairingCommand(link.url));
  await fixture.send(
    id,
    2,
    {
      caption: "Read code",
      caption_entities: [{ type: "code", offset: 5, length: 4 }],
      photo: [{ file_id: "photo", width: 20, height: 20, file_size: 120 }],
    },
    991,
    501,
  );
  await vi.waitFor(() => expect(fixture.outbound).toHaveLength(1), WAIT);
  expect(JSON.stringify(fixture.model.requests[0])).toContain("Read `code`");
  expect(JSON.stringify(fixture.model.requests[0])).toContain("photo.jpg");
  await fixture.send(id, 3, { contact: { phone_number: "123", first_name: "Ada" } }, 991, 502);
  await vi.waitFor(() => expect(fixture.outbound).toHaveLength(2), WAIT);
  expect(JSON.stringify(fixture.model.requests[1])).toContain("👤 Ada 123");
  await fixture.send(
    id,
    4,
    {
      caption: "Animation caption",
      animation: { file_id: "animation", width: 20, height: 20, duration: 1 },
      document: { file_id: "animation", file_name: "animation.gif" },
    },
    991,
    503,
  );
  await vi.waitFor(() => expect(fixture.outbound).toHaveLength(3), WAIT);
  const animation = JSON.stringify(fixture.model.requests[2]);
  expect(animation).toContain("Animation caption");
  expect(animation).not.toMatch(/attachmentId [a-f0-9-]{36}/);
});
