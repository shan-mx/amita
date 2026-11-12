import { createAgent } from "./helpers";
import { COMPANION_PROTOCOL } from "../src/shared/companion";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { env, SELF, evictDurableObject } from "cloudflare:test";
import type { Env } from "../src/env";
import type { RemoteRequest } from "../src/shared/companion";
import { owner, modelFixture, WAIT } from "./helpers";

const sockets: WebSocket[] = [];
afterEach(() => {
  sockets.splice(0).forEach((socket) => socket.close());
  vi.restoreAllMocks();
});
async function computer(account: ReturnType<typeof owner>, home: string) {
  const registration = await account.client.computer.registration();
  const registered = await SELF.fetch("https://app.test/api/companion/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: registration.code, name: home }),
  });
  const device = await registered.json<{ deviceId: string; credential: string }>();
  const slug = `workspace-${home.replaceAll("/", "").toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`;
  await account.client.computer.confirm({
    deviceId: device.deviceId,
    slug,
  });
  const connected = await SELF.fetch("https://app.test/api/companion/connect", {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${device.credential}` },
  });
  const ws = connected.webSocket!;
  ws.accept();
  sockets.push(ws);
  const requests: RemoteRequest[] = [];
  const files = new Map<string, string>();
  const directories = new Set<string>();
  let ready = false;
  ws.addEventListener("message", ({ data }) => {
    const frame = JSON.parse(String(data));
    if (frame.type === "ready") ready = true;
    if (frame.type !== "execute") return;
    requests.push(frame);
    const p = frame.params;
    const resolvedPath =
      typeof p.path === "string" && p.path.startsWith("/")
        ? p.path
        : `${p.cwd}/${String(p.path).replace(/^\/+/, "")}`;
    if (frame.workspace) directories.add(frame.workspace);
    if (frame.method === "mkdir") directories.add(resolvedPath);
    if (frame.method === "writeFile") files.set(resolvedPath, p.content);
    if (frame.method === "exec")
      ws.send(
        JSON.stringify({
          type: "output",
          id: frame.id,
          seq: 1,
          snapshot: true,
          before: { bytes: 0, newlines: 0, endsWithNewline: false },
          stream: "stdout",
          text: `${p.cwd}\n`,
        }),
      );
    let value: unknown = null;
    if (frame.method === "absolutePath") {
      value = p.path.startsWith("/") ? p.path : `${p.cwd}/${p.path}`;
    } else if (frame.method === "exec") {
      value = { exitCode: 0 };
    }
    ws.send(JSON.stringify({ type: "result", id: frame.id, seq: 2, result: { ok: true, value } }));
  });
  ws.send(
    JSON.stringify({
      type: "hello",
      protocol: COMPANION_PROTOCOL,
      name: home,
      cwd: `${home}/launch`,
      home,
      os: "darwin",
    }),
  );
  await vi.waitFor(() => expect(ready).toBe(true), WAIT);
  return {
    id: device.deviceId,
    slug,
    home,
    requests,
    files,
    directories,
  };
}
async function run(
  account: ReturnType<typeof owner>,
  agentId: string,
  code: string,
  plan: { code: string },
) {
  plan.code = code;
  const session = await account.client.sessions.create({ agentId });
  const target = { agentId, sessionId: session.id };
  await account.client.sessions.submit({
    ...target,
    text: "Run the workspace fixture.",
    operationId: crypto.randomUUID(),
  });
  let history: Awaited<ReturnType<typeof account.client.sessions.history>>;
  await vi.waitFor(async () => {
    history = await account.client.sessions.history(target);
    expect(
      history.entries
        .flatMap((entry) => entry.model ?? [])
        .some(
          (message) =>
            message.role === "assistant" &&
            JSON.stringify(message.content).includes("WORKSPACE_DONE"),
        ),
    ).toBe(true);
  }, WAIT);
  const result = history!.entries
    .flatMap((entry) => entry.model ?? [])
    .find((message) => message.role === "toolResult" && message.toolName === "codemode");
  expect(result).toMatchObject({ isError: false });
  return JSON.stringify(result);
}

it("uses the Agent Slug in separate default workspaces on each Computer and after eviction", async () => {
  const account = owner();
  await account.login();
  const a = await computer(account, "/home/a");
  const b = await computer(account, "/home/b");
  const plan = { code: "" };
  modelFixture(({ messages }) =>
    messages.some((message) => message.role === "tool")
      ? { text: "WORKSPACE_DONE" }
      : { tool: { name: "codemode", arguments: { code: plan.code } } },
  );
  const first = (await createAgent(account.client, { name: "First workspace", persona: "" })).agent;
  const second = (await createAgent(account.client, { name: "Second workspace", persona: "" }))
    .agent;
  const bindings = env as unknown as Env;
  for (const agent of [first, second]) {
    const code = `return await Promise.all(${JSON.stringify([a.slug, b.slug])}.map(async computer => {
      const result = await tools.bash({computer,command:"pwd"});
      await tools.fs_write({path:"/computers/"+computer+"/workspace/owned.txt",content:${JSON.stringify(agent.id)}});
      return result.output;
    }));`;
    const result = await run(account, agent.id, code, plan);
    for (const device of [a, b]) {
      const workspace = `${device.home}/.amita/workspaces/${agent.slug}`;
      expect(result).toContain(workspace);
      expect(device.directories.has(workspace)).toBe(true);
      expect(device.files.get(`${workspace}/owned.txt`)).toBe(agent.id);
    }
  }
  await account.client.agents.update({ agentId: second.id, name: "Renamed workspace" });
  const secondStub = bindings.AGENTS.getByName(second.id);
  await evictDurableObject(secondStub);
  const again = await run(
    account,
    second.id,
    `return await tools.bash({computer:${JSON.stringify(a.slug)},command:"pwd"});`,
    plan,
  );
  expect(again).toContain(`/home/a/.amita/workspaces/${second.slug}`);
  await run(
    account,
    first.id,
    `await tools.fs_write({path:"/computers/${a.slug}/fs/outside/external.txt",content:"authorized"});return await tools.bash({computer:${JSON.stringify(a.slug)},cwd:"/outside",command:"pwd"});`,
    plan,
  );
  expect(a.files.get("/outside/external.txt")).toBe("authorized");
  const requestsBeforeEscape = a.requests.length;
  const escaped = JSON.stringify(`/computers/${a.slug}/workspace/child/../../outside`);
  const rejected = await run(
    account,
    first.id,
    `const path = ${escaped};
return await Promise.all([
  tools.fs_mkdir({path}).catch(error => "file: " + error.message),
  tools.bash({computer:${JSON.stringify(a.slug)},cwd:path,command:"pwd"})
    .catch(error => "bash: " + error.message)
]);`,
    plan,
  );
  expect(rejected).toContain("file: The path escapes its virtual workspace mount.");
  expect(rejected).toContain("bash: The path escapes its virtual workspace mount.");
  expect(a.requests).toHaveLength(requestsBeforeEscape);
});
