import { createAgent } from "./helpers";
import { Buffer } from "node:buffer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { env, evictDurableObject, SELF } from "cloudflare:test";
import type { Env } from "../src/env";
import { match } from "ts-pattern";
import { LineScanner } from "@earendil-works/pi-durable/env";
import { COMPANION_PROTOCOL, type RemoteRequest } from "../src/shared/companion";
import { codemodeToolCall, modelFixture, owner, WAIT } from "./helpers";

const LISTED_FILENAME = "Café 100%.md";
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  vi.restoreAllMocks();
});
async function fixture(
  files?: Map<string, string>,
  failure?: { method: string; code: string; message: string },
  scan?: { value: unknown },
) {
  const account = owner();
  await account.login();
  const registration = await account.client.computer.registration();
  const response = await SELF.fetch("https://app.test/api/companion/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: registration.code, name: "Filesystem fixture" }),
  });
  const device = await response.json<{ deviceId: string; credential: string }>();
  const slug = `filesystem-${crypto.randomUUID().slice(0, 8)}`;
  await account.client.computer.confirm({
    deviceId: device.deviceId,
    slug,
  });
  const connection = await SELF.fetch("https://app.test/api/companion/connect", {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${device.credential}` },
  });
  const ws = connection.webSocket!;
  sockets.push(ws);
  ws.accept();
  let ready = false;
  const requests: RemoteRequest[] = [];
  ws.addEventListener("message", ({ data }) => {
    const frame = JSON.parse(String(data));
    if (frame.type === "ready") ready = true;
    if (frame.type !== "execute") return;
    requests.push(frame);
    if (failure && failure.method === frame.method) {
      const { code, message } = failure;
      const result = { ok: false, error: { code, message } };
      ws.send(JSON.stringify({ type: "result", id: frame.id, seq: 1, result }));
      return;
    }
    if (files && frame.method !== "absolutePath") {
      const path = frame.params.path ?? frame.params.handle;
      const content = files.get(path);
      const bytes = new TextEncoder().encode(content ?? "");
      const info = { kind: "file", size: bytes.length, mtimeMs: 1 };
      const result = match(frame.method)
        .with("writeFile", () => {
          files.set(path, frame.params.content);
          return { ok: true, value: null };
        })
        .with("mkdir", () => ({ ok: true, value: null }))
        .with("exists", () => ({ ok: true, value: files.has(path) }))
        .with("readerClose", () => ({ ok: true, value: null }))
        .otherwise((method) => {
          if (content === undefined)
            return {
              ok: false,
              error: { code: "not_found", message: "file not found" },
            };

          const value = match(method)
            .with("fileInfo", "readerInfo", () => info)
            .with("readTextFile", () => btoa(String.fromCharCode(...bytes)))
            .with("readerRead", () =>
              Buffer.from(
                bytes.subarray(frame.params.offset, frame.params.offset + frame.params.length),
              ).toString("base64"),
            )
            .with("readerScanLines", () => {
              if (scan) return scan.value;
              const scanner = new LineScanner(frame.params.startLine, frame.params.endLine);
              scanner.push(bytes);
              return scanner.finish();
            })
            .otherwise(() => path);

          return { ok: true, value };
        });
      ws.send(JSON.stringify({ type: "result", id: frame.id, seq: 1, result }));
      return;
    }
    const value = match(frame.method)
      .with("absolutePath", () => frame.params.path)
      .with("listDir", () => ({
        entries: [
          {
            name: LISTED_FILENAME,
            path: `${frame.params.path}/${LISTED_FILENAME}`,
            kind: "file",
            size: 4,
            mtimeMs: 1,
          },
        ],
      }))
      .otherwise(() => null);
    ws.send(JSON.stringify({ type: "result", id: frame.id, seq: 1, result: { ok: true, value } }));
  });
  ws.send(
    JSON.stringify({
      type: "hello",
      protocol: COMPANION_PROTOCOL,
      name: "Filesystem fixture",
      cwd: "/fixture",
      home: "/fixture",
      os: "darwin",
    }),
  );
  await vi.waitFor(() => expect(ready).toBe(true), WAIT);
  return { account, device, slug, requests };
}
async function execute(
  account: ReturnType<typeof owner>,
  tool: { name: string; arguments: object },
  target?: { agentId: string; sessionId: string },
) {
  modelFixture(({ messages }) =>
    messages.some((message) => message.role === "tool")
      ? { text: "FILESYSTEM_FIXTURE_DONE" }
      : { tool },
  );
  if (!target) {
    const created = await createAgent(account.client, {
      name: "Filesystem routing fixture",
      persona: "",
    });
    target = { agentId: created.agent.id, sessionId: created.sessionId };
  }
  const session = target;
  await account.client.sessions.submit({
    ...session,
    text: "Use the requested filesystem tool.",
    operationId: crypto.randomUUID(),
  });
  let entries: Awaited<ReturnType<typeof account.client.sessions.history>>["entries"] = [];
  await vi.waitFor(async () => {
    entries = (await account.client.sessions.history(session)).entries;
    expect(
      entries
        .flatMap((e) => e.model ?? [])
        .some(
          (m) =>
            m.role === "assistant" && JSON.stringify(m.content).includes("FILESYSTEM_FIXTURE_DONE"),
        ),
    ).toBe(true);
  }, WAIT);
  return entries
    .flatMap((e) => e.model ?? [])
    .find((m) => m.role === "toolResult" && m.toolName === tool.name)!;
}

it("returns virtual paths and file attributes when listing a Computer directory", async () => {
  const { account, slug, requests } = await fixture();
  const path = `/computers/${slug}/fs/fixture`;
  const result = await execute(account, codemodeToolCall("fs_list", { path }));
  expect(result).toMatchObject({ isError: false });
  const returned = result.role === "toolResult" ? result.content.at(-1) : undefined;
  expect(JSON.parse(returned?.type === "text" ? returned.text : "null")).toMatchObject({
    entries: [{ path: `${path}/${LISTED_FILENAME}`, kind: "file", size: 4, mtimeMs: 1 }],
  });
  expect(requests.find((request) => request.method === "listDir")?.params.path).toBe("/fixture");
});

it("requires a complete virtual path for native filesystem writes", async () => {
  const { account, requests } = await fixture();
  const result = await execute(
    account,
    codemodeToolCall("fs_write", {
      path: "fixture/protected.md",
      content: "must not be written",
    }),
  );
  expect(result).toMatchObject({ isError: true });
  expect(requests).toEqual([]);
});

const outputText = (result: Awaited<ReturnType<typeof execute>>) =>
  result.role === "toolResult"
    ? result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
    : "";

it("uses Pi path normalization and fuzzy text matching", async () => {
  const hostPath = "/fixture/Café\u00a0notes 100%.md";
  const sibling = "/fixture/Café notes 100%.md";
  const files = new Map([
    [hostPath, "UNICODE SIBLING"],
    [sibling, "owner’s original"],
  ]);
  const { account, slug } = await fixture(files);
  const path = `/computers/${slug}/fs${hostPath}`;
  const result = await execute(account, {
    name: "codemode",
    arguments: {
      code: `const path = ${JSON.stringify(path)};
const before = await tools.fs_read({path});
await tools.fs_edit({path, edits: [{oldText: "owner's original", newText: "edited"}]});
const edited = await tools.fs_read({path});
await tools.fs_write({path, content: "final"});
return {before, edited, after: await tools.fs_read({path})};`,
    },
  });
  expect(result).toMatchObject({ isError: false });
  expect(outputText(result)).toContain('"before":"owner’s original"');
  expect(outputText(result)).toContain('"edited":"edited"');
  expect(outputText(result)).toContain('"after":"final"');
  expect(files.get(hostPath)).toBe("UNICODE SIBLING");
  expect(files.get(sibling)).toBe("final");
});

it("uses Pi apostrophe fallback when the original spelling is missing", async () => {
  const files = new Map([["/fixture/owner’s.md", "another file"]]);
  const { account, slug, requests } = await fixture(files);
  const result = await execute(account, {
    name: "fs_read",
    arguments: { path: `/computers/${slug}/fs/fixture/owner's.md` },
  });
  expect(result).toMatchObject({ isError: false });
  expect(outputText(result)).toBe("another file");
  expect(requests.find((request) => request.method === "openBinaryReader")?.params.path).toBe(
    "/fixture/owner’s.md",
  );
});

it.each([
  {
    code: "conflict",
    message:
      "The file changed before the edit could be saved. No changes were written. Read the file again with fs_read and revise the edit against the current contents before retrying.",
  },
  {
    code: "unknown",
    message: "no space left on device",
  },
])(
  "reports a Companion edit failure ($code) without overwriting the file",
  async ({ code, message }) => {
    const hostPath = "/fixture/edit-failure.md";
    const files = new Map([[hostPath, "original"]]);
    const { account, slug } = await fixture(files, {
      method: "writeFile",
      code,
      message,
    });
    const args = {
      path: `/computers/${slug}/fs${hostPath}`,
      edits: [{ oldText: "original", newText: "edited" }],
    };
    const result = await execute(account, {
      name: "codemode",
      arguments: {
        code: `try { await tools.fs_edit(${JSON.stringify(args)}); return "missing error"; } catch (error) { return String(error); }`,
      },
    });
    expect(result).toMatchObject({ isError: false });

    expect(outputText(result)).toContain(
      "Could not edit file: /fixture/edit-failure.md. Error code: unknown.",
    );
    expect(files.get(hostPath)).toBe("original");
  },
);

it("tells the model to reopen the same file after a Companion read expires", async () => {
  const hostPath = "/fixture/expired-read.md";
  const { account, slug } = await fixture(new Map([[hostPath, "text"]]), {
    method: "readerRead",
    code: "reader_expired",
    message: "The file read was interrupted. Call fs_read again on the same path.",
  });
  const result = await execute(account, {
    name: "fs_read",
    arguments: { path: `/computers/${slug}/fs${hostPath}` },
  });
  expect(result).toMatchObject({ isError: true });
  expect(outputText(result)).not.toContain("[reader_expired]");
  expect(outputText(result)).toContain("Call fs_read again on the same path.");
  expect(outputText(result)).not.toContain("side-effecting operations");
});

it("keeps native edit access errors distinct from text matching errors", async () => {
  const { account, slug } = await fixture(new Map([["/fixture/existing.md", "original"]]));
  const denied = await execute(
    account,
    codemodeToolCall("fs_edit", {
      path: `/computers/${slug}/fs/fixture/missing.md`,
      edits: [{ oldText: "original", newText: "edited" }],
    }),
  );
  expect(outputText(denied)).toContain("Error code: not_found");
  const unmatched = await execute(
    account,
    codemodeToolCall("fs_edit", {
      path: `/computers/${slug}/fs/fixture/existing.md`,
      edits: [{ oldText: "absent", newText: "edited" }],
    }),
  );
  expect(outputText(unmatched)).toContain("Could not find");
  expect(outputText(unmatched)).not.toContain("[invalid]");
});

it("uses the internal mount through the existing file tools without a Companion", async () => {
  const editedLine = "Café 🙂";
  const account = owner();
  await account.login();
  const created = await createAgent(account.client, { name: "Internal files", persona: "" });
  const target = { agentId: created.agent.id, sessionId: created.sessionId };
  const result = await execute(
    account,
    {
      name: "codemode",
      arguments: {
        code: `
const dir = "/internal/notes";
const path = dir + "/a.md";
await tools.fs_mkdir({path: dir});
const written = await tools.fs_write({path, content: "first\\nfind [me]\\nlast"});
await Promise.all([
  tools.fs_edit({path, edits:[{oldText:"first",newText:${JSON.stringify(editedLine)}}]}),
  tools.fs_edit({path, edits:[{oldText:"last",newText:"END"}]})
]);
await tools.fs_write({path:dir + "/b.md", content:"a second file"});
const glob = await tools.fs_glob({path:"/internal",pattern:"notes/**/*.md",limit:1});
const grep = await tools.fs_grep({path:dir,pattern:"FIND [me]",include:"*.md",literal:true,caseSensitive:false});
const regex = await tools.fs_grep({path,pattern:"^END$",context:0});
const listed = await tools.fs_list({path:dir,limit:1});
const next = await tools.fs_list({path:dir,cursor:listed.nextCursor});
await tools.fs_remove({path:dir + "/b.md"});
const root = await tools.fs_remove({path:"/internal/notes/..",recursive:true}).catch(String);
const nestedDir = "/internal/new/deep";
const nested = nestedDir + "/bom.md";
await tools.fs_write({path:nested,content:"\uFEFFbefore"});
await tools.fs_edit({path:nested,edits:[{oldText:"before",newText:"after"}]});
const {entries: [{size: bomFileSize}]} = await tools.fs_list({path:nestedDir});
const bomFile = await tools.fs_read({path:nested});
await tools.fs_mkdir({path:"/internal/workspace"});
const missing = await tools.fs_read({path:"/internal/workspace/missing.md"}).catch(String);
return {glob, grep, regex, next, root, written, bomFile, bomFileSize, missing, read:await tools.fs_read({path})};
`,
      },
    },
    target,
  );
  const output = outputText(result);
  expect(output).toContain('"paths":["/internal/notes/a.md"],"truncated":true');
  expect(output).toContain(
    `"line":2,"text":"find [me]","before":["${editedLine}"],"after":["END"]`,
  );
  expect(output).toContain('"line":3,"text":"END","before":[],"after":[]');
  expect(output).toContain("/internal/notes/b.md");
  expect(output).toContain("Cannot remove /internal.");
  expect(output).toContain("Successfully wrote to /internal/notes/a.md");
  expect(output).toContain("/internal/workspace/missing.md");
  expect(output).toContain('"bomFile":"after"');
  expect(output).toContain(`"bomFileSize":${new TextEncoder().encode("\uFEFFafter").byteLength}`);

  const bindings = env as unknown as Env;
  await evictDurableObject(bindings.AGENTS.getByName(target.agentId));
  const session = await account.client.sessions.create({ agentId: target.agentId });
  const read = await execute(
    account,
    {
      name: "fs_read",
      arguments: { path: "/internal/notes/a.md" },
    },
    { ...target, sessionId: session.id },
  );
  expect(outputText(read)).toBe(`${editedLine}\nfind [me]\nEND`);
  const isolated = await execute(account, {
    name: "fs_read",
    arguments: { path: "/internal/notes/a.md" },
  });
  expect(isolated).toMatchObject({ isError: true });
});

it("reads a late Unicode range without transferring the file for line scanning", async () => {
  const lines = Array.from({ length: 400000 }, (_, index) => `line ${index} 🙂`);
  const { account, slug, requests } = await fixture(
    new Map([["/fixture/large.txt", lines.join("\n")]]),
  );
  const result = await execute(account, {
    name: "fs_read",
    arguments: {
      path: `/computers/${slug}/fs/fixture/large.txt`,
      offset: 350001,
      limit: 2,
    },
  });
  expect(outputText(result).split("\n").slice(0, 2)).toEqual(lines.slice(350000, 350002));
  expect(requests.filter((request) => request.method === "readerScanLines")).toHaveLength(1);
  const transferred = requests
    .filter((request) => request.method === "readerRead")
    .reduce((bytes, request) => bytes + Number(request.params.length), 0);
  expect(transferred).toBeLessThan(64 * 1024);
});

it("reports malformed line scan metadata as a tool error", async () => {
  const { account, slug } = await fixture(
    new Map([["/fixture/note.txt", "hello\nworld"]]),
    undefined,
    { value: { newlines: "invalid" } },
  );
  const result = await execute(account, {
    name: "fs_read",
    arguments: { path: `/computers/${slug}/fs/fixture/note.txt` },
  });
  expect(result).toMatchObject({ isError: true });
  expect(JSON.stringify(result)).toContain("The Computer returned an invalid line scan result.");
});
