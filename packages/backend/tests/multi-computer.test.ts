import { createAgent } from "./helpers";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { env, SELF, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { codemodeToolCall, owner, modelFixture, WAIT } from "./helpers";
import type { Env } from "../src/env";
import { digest } from "../src/http/auth";
import { COMPANION_PROTOCOL, type RemoteRequest } from "../src/shared/companion";

const sockets: WebSocket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  vi.restoreAllMocks();
});

async function freshAccount() {
  const account = owner();
  await account.login();
  const status = await account.client.computer.status();
  const devices = status.computers;
  for (const device of devices) await account.client.computer.revoke({ deviceId: device.id });
  return account;
}
async function redeem(code: string, name: string) {
  const response = await SELF.fetch("https://app.test/api/companion/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, name }),
  });
  expect(response.status).toBe(200);
  return response.json<{ deviceId: string; credential: string }>();
}
async function pair(account: Awaited<ReturnType<typeof owner>>, name: string) {
  const device = await redeem((await account.client.computer.registration()).code, name);
  const slug = `${name.toLowerCase().replaceAll(" ", "-")}-${crypto.randomUUID().slice(0, 8)}`;
  await account.client.computer.confirm({
    deviceId: device.deviceId,
    slug,
  });
  return { ...device, slug };
}
async function connect(device: { credential: string }, name: string, cwd: string, os = "darwin") {
  const response = await SELF.fetch("https://app.test/api/companion/connect", {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${device.credential}` },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  sockets.push(ws);
  ws.accept();
  let ready = false;
  const requests: RemoteRequest[] = [];
  ws.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.type === "ready") ready = true;
    if (message.type !== "execute") return;
    requests.push(message);
    ws.send(
      JSON.stringify({
        type: "output",
        id: message.id,
        seq: 1,
        snapshot: true,
        before: { bytes: 0, newlines: 0, endsWithNewline: false },
        stream: "stdout",
        text: `${name}:${message.params.cwd}\n`,
      }),
    );
    ws.send(
      JSON.stringify({
        type: "result",
        id: message.id,
        seq: 2,
        result: { ok: true, value: { exitCode: 0 } },
      }),
    );
  });
  ws.send(
    JSON.stringify({ type: "hello", protocol: COMPANION_PROTOCOL, name, cwd, home: cwd, os }),
  );
  await vi.waitFor(() => expect(ready).toBe(true), WAIT);
  return { ws, requests };
}
async function chat(
  account: Awaited<ReturnType<typeof owner>>,
  tool: { name: string; arguments: object },
) {
  modelFixture(({ messages }) =>
    messages.some((message) => message.role === "tool")
      ? { text: "MULTI_COMPUTER_DONE" }
      : { tool },
  );
  const created = await createAgent(account.client, {
    name: "Multi Computer fixture",
    persona: "",
  });
  const target = { agentId: created.agent.id, sessionId: created.sessionId };
  await account.client.sessions.submit({
    ...target,
    text: "Run the fixture.",
    operationId: crypto.randomUUID(),
  });
  let entries: unknown[] = [];
  await vi.waitFor(async () => {
    entries = (await account.client.sessions.history(target)).entries;
    expect(JSON.stringify(entries)).toContain("MULTI_COMPUTER_DONE");
  }, WAIT);
  return JSON.stringify(entries);
}

it("keeps independent pairing codes and device identities across registry eviction", async () => {
  const account = await freshAccount();
  const firstCode = await account.client.computer.registration();
  const secondCode = await account.client.computer.registration();
  const first = await redeem(firstCode.code, "Same display name");
  const second = await redeem(secondCode.code, "Same display name");
  await account.client.computer.confirm({
    deviceId: first.deviceId,
    slug: `same-display-first-${crypto.randomUUID().slice(0, 8)}`,
  });
  await account.client.computer.confirm({
    deviceId: second.deviceId,
    slug: `same-display-second-${crypto.randomUUID().slice(0, 8)}`,
  });
  expect(first.deviceId).not.toBe(second.deviceId);
  expect(first.credential).not.toBe(second.credential);
  const deployment = (env as unknown as Env).DEPLOYMENT.getByName("deployment");
  await evictDurableObject(deployment);
  const status = await account.client.computer.status();
  expect(status.computers.map((device) => device.id).sort()).toEqual(
    [first.deviceId, second.deviceId].sort(),
  );
  expect(status.computers).toHaveLength(2);
  const laterCode = await account.client.computer.registration();
  expect(laterCode.id).not.toBe(firstCode.id);
  expect(
    (await account.client.computer.status({ registrationId: firstCode.id })).registrationActive,
  ).toBe(false);
  expect(
    (await account.client.computer.status({ registrationId: laterCode.id })).registrationActive,
  ).toBe(true);
  const reused = await SELF.fetch("https://app.test/api/companion/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: firstCode.code, name: "Reuse" }),
  });
  expect(reused.status).toBe(403);
});

it("routes equal commands to their explicit Computer and keeps the sibling alive after revocation", async () => {
  const account = await freshAccount();
  const first = await pair(account, "First");
  const second = await pair(account, "Second");
  const a = await connect(first, "First", "/first");
  const b = await connect(second, "Second", "/second");
  const result = await chat(account, {
    name: "codemode",
    arguments: {
      code: `
    return await Promise.all([
      tools.bash({computer:${JSON.stringify(first.slug)},command:"pwd",cwd:"/chosen"}),
      tools.bash({computer:${JSON.stringify(second.slug)},cwd:"/second",command:"pwd"})
    ]);`,
    },
  });
  expect(result).toContain("First:/chosen");
  expect(result).toContain("Second:/second");
  expect(a.requests).toHaveLength(1);
  expect(b.requests).toHaveLength(1);
  expect(a.requests[0].id).not.toBe(b.requests[0].id);
  await account.client.computer.revoke({ deviceId: first.deviceId });
  expect((await account.client.computer.status()).computers).toMatchObject([
    { id: second.deviceId, online: true },
  ]);
  const next = await chat(
    account,
    codemodeToolCall("bash", { computer: second.slug, cwd: "/second", command: "pwd" }),
  );
  expect(next).toContain("Second:/second");
  expect(b.requests).toHaveLength(2);
  const denied = await SELF.fetch("https://app.test/api/companion/connect", {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${first.credential}` },
  });
  expect(denied.status).toBe(403);
});

it("rejects an omitted Computer instead of guessing the single online device", async () => {
  const account = await freshAccount();
  const device = await pair(account, "No implicit target");
  const linked = await connect(device, "No implicit target", "/only");
  const result = await chat(account, codemodeToolCall("bash", { command: "pwd" }));
  expect(result).toContain('"isError":true');
  expect(result).toContain("computer");
  expect(linked.requests).toHaveLength(0);
});

it("reports the selected offline Computer without using the online Computer", async () => {
  const account = await freshAccount();
  const offline = await pair(account, "Offline fixture");
  const online = await pair(account, "Online fixture");
  const linked = await connect(online, "Online fixture", "/online");
  const result = await chat(
    account,
    codemodeToolCall("bash", { computer: offline.slug, command: "pwd" }),
  );
  expect(result).toContain(
    `Computer ${offline.slug} is offline. The operation did not run. Try again after the computer reconnects.`,
  );
  expect(linked.requests).toHaveLength(0);
});

it("rejects an active Computer credential without a Slug", async () => {
  await freshAccount();
  const id = crypto.randomUUID();
  const credential = "L".repeat(43);
  const hash = await digest(credential);
  const deployment = (env as unknown as Env).DEPLOYMENT.getByName("deployment");
  await runInDurableObject(deployment, (_instance, state) => {
    state.storage.sql.exec(
      "INSERT INTO computer(id,name,state,confirmation_expires_at,credential_hash,created_at) VALUES(?,?,?,?,?,?)",
      id,
      "Slugless",
      "active",
      0,
      hash,
      Date.now(),
    );
  });
  const response = await SELF.fetch("https://app.test/api/companion/connect", {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${credential}` },
  });
  expect(response.status).toBe(403);
});

it("accepts a Linux Companion and reports it online after the real handshake", async () => {
  const account = await freshAccount();
  const device = await pair(account, "Linux fixture");
  await connect(device, "Linux fixture", "/home/fixture", "linux");
  await vi.waitFor(async () => {
    const status = await account.client.computer.status();
    expect(status.computers.find((computer) => computer.id === device.deviceId)?.online).toBe(true);
  }, WAIT);
});
