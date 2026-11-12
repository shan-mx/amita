import { COMPANION_PROTOCOL } from "../src/shared/companion";
import { SELF } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { agent, pairingCommand, telegram } from "./channels-fixture";
import { WAIT } from "./helpers";

afterEach(() => vi.restoreAllMocks());

it("sends current file bytes and sizes to the exact Topic and preserves receipts across rate limiting", async () => {
  const computer = "upload-" + crypto.randomUUID().slice(0, 8);
  const photo = Uint8Array.from({ length: 140_000 }, (_, index) => index % 251);
  const document = new TextEncoder().encode(
    "%PDF-1.7 updated after selection, with a different size",
  );
  let documentAttempts = 0;
  const files = new Map([
    ["/tmp/photo.png", { data: photo, mediaType: "image/png" }],
    [
      "/tmp/report.pdf",
      { data: new TextEncoder().encode("%PDF-1.7 old"), mediaType: "application/pdf" },
    ],
  ]);
  const fixture = telegram({
    model: ({ messages }) =>
      messages.some(({ role }) => role === "tool")
        ? { text: "Upload finished" }
        : {
            tool: {
              name: "channel_send",
              arguments: {
                target: "current",
                text: "Files follow",
                files: [...files.keys()].map((path) => ({
                  path: `/computers/${computer}/fs${path}`,
                })),
              },
            },
          },
    onSend: ({ text }) => {
      if (text === "Files follow") files.get("/tmp/report.pdf")!.data = document;
    },
    onUpload: (method) => {
      if (method !== "sendDocument" || documentAttempts++ > 0) return;
      return Response.json(
        { ok: false, error_code: 429, parameters: { retry_after: 1 } },
        { status: 429 },
      );
    },
  });
  const { client, agentId } = await agent();
  const registration = await client.computer.registration();
  const registered = await SELF.fetch("https://amita.test/api/companion/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: registration.code, name: "Upload fixture" }),
  });
  const device = await registered.json<{ deviceId: string; credential: string }>();
  await client.computer.confirm({ deviceId: device.deviceId, slug: computer });
  const connected = await SELF.fetch("https://amita.test/api/companion/connect", {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${device.credential}` },
  });
  const socket = connected.webSocket!;
  socket.accept();
  let ready = false;
  const opens: string[] = [];
  socket.addEventListener("message", ({ data }) => {
    const frame = JSON.parse(String(data));
    if (frame.type === "ready") ready = true;
    if (frame.type !== "file_request") return;
    const params = frame.params;
    const file = files.get(params.path);
    let value: unknown = null;
    if (frame.method === "inspectExport" && file) {
      value = {
        name: params.path.split("/").at(-1),
        size: file.data.byteLength,
        mediaType: file.mediaType,
      };
    }
    if (frame.method === "exportFile" && file) {
      opens.push(params.path);
      {
        for (let offset = 0; offset < file.data.length; offset += 65_536) {
          socket.send(
            JSON.stringify({
              type: "file_chunk",
              id: frame.id,
              content: btoa(
                Array.from(file.data.subarray(offset, offset + 65_536), (byte) =>
                  String.fromCharCode(byte),
                ).join(""),
              ),
            }),
          );
        }
      }
    }
    socket.send(
      JSON.stringify({
        type: "file_result",
        id: frame.id,
        result: { ok: true, value },
      }),
    );
  });
  socket.send(
    JSON.stringify({
      type: "hello",
      protocol: COMPANION_PROTOCOL,
      name: "Upload fixture",
      cwd: "/tmp",
      home: "/tmp",
      os: "darwin",
    }),
  );
  try {
    await vi.waitFor(() => expect(ready).toBe(true), WAIT);
    const { id } = await client.channels.connect({
      agentId,
      token: "352:fixture",
    });
    const link = await client.channels.pair({ agentId, id });
    await fixture.send(id, 1, pairingCommand(link.url));
    await fixture.send(id, 2, "Send these files", 991, 519);
    await vi.waitFor(
      () => expect(fixture.outbound.map(({ text }) => text)).toContain("Files follow"),
      WAIT,
    );
    await vi.waitFor(() => expect(fixture.outbound.at(-1)?.text).toBe("Upload finished"), WAIT);
    const uploads = fixture.calls.filter(
      ({ method }) => method === "sendPhoto" || method === "sendDocument",
    );
    expect(uploads.map(({ method }) => method)).toEqual([
      "sendPhoto",
      "sendDocument",
      "sendDocument",
    ]);
    const [first, second] = uploads.map(({ body }) => body);
    expect(first.message_thread_id).toBe("519");
    expect(second.message_thread_id).toBe("519");
    expect(new Uint8Array(await (first.photo as File).arrayBuffer())).toEqual(photo);
    expect(new Uint8Array(await (second.document as File).arrayBuffer())).toEqual(document);
    expect(opens).toEqual(["/tmp/photo.png", "/tmp/report.pdf", "/tmp/report.pdf"]);
    const toolResult = fixture.model.requests
      .at(-1)
      ?.messages.find(({ role }) => role === "tool")?.content;
    expect(toolResult).toEqual(expect.stringContaining('"status":"sent"'));
    expect(toolResult).toEqual(expect.stringContaining('"files":[{"name":"photo.png","receipt":'));
  } finally {
    socket.close();
  }
});
