import { afterEach, expect, it, vi } from "vite-plus/test";
import { SELF, env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { owner } from "./helpers";
import type { Env } from "../src/env";

const deployment = () => (env as unknown as Env).DEPLOYMENT.getByName("deployment");
afterEach(() => vi.restoreAllMocks());
async function pending() {
  const account = owner();
  await account.login();
  const registration = await account.client.computer.registration();
  const response = await SELF.fetch("https://amita.test/api/companion/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: registration.code, name: "Alex's MacBook Pro" }),
  });
  expect(response.status).toBe(200);
  return {
    account,
    device: await response.json<{ deviceId: string; credential: string; expiresAt: number }>(),
  };
}
function status(credential: string, path = "status") {
  return SELF.fetch(`https://amita.test/api/companion/${path}`, {
    headers: {
      Authorization: `Bearer ${credential}`,
      ...(path === "connect" ? { Upgrade: "websocket" } : {}),
    },
  });
}
it("keeps a registered credential pending until Owner confirmation, including after restart", async () => {
  const { account, device } = await pending();
  expect((await status(device.credential, "connect")).status).toBe(403);
  expect(await (await status(device.credential)).json()).toMatchObject({
    state: "pending",
    deviceId: device.deviceId,
  });
  await evictDurableObject(deployment());
  const list = await account.client.computer.status();
  expect(list.pending).toContainEqual(
    expect.objectContaining({
      id: device.deviceId,
      name: "Alex's MacBook Pro",
      suggestedSlug: "alex-s-macbook-pro",
    }),
  );
  const slug = `mac-${crypto.randomUUID().slice(0, 8)}`;
  const confirmed = await account.client.computer.confirm({ deviceId: device.deviceId, slug });
  expect(confirmed).toMatchObject({ id: device.deviceId, slug, state: "active" });
  expect(
    await account.client.computer.confirm({ deviceId: device.deviceId, slug: "different-slug" }),
  ).toEqual(confirmed);
  expect(await (await status(device.credential)).json()).toMatchObject({ state: "active", slug });
  await account.client.computer.revoke({ deviceId: device.deviceId });
  expect((await status(device.credential, "connect")).status).toBe(403);
  expect(await account.client.computer.confirm({ deviceId: device.deviceId, slug })).toMatchObject({
    id: device.deviceId,
    slug,
    state: "revoked",
  });
});
it("reserves a slug across concurrent confirmation and revocation with a database constraint", async () => {
  const first = await pending();
  const second = await pending();
  const slug = `unique-${crypto.randomUUID().slice(0, 8)}`;
  const results = await Promise.allSettled(
    [first, second].map(({ account, device }) =>
      account.client.computer.confirm({ deviceId: device.deviceId, slug }),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const winner = results[0].status === "fulfilled" ? first : second;
  const loser = winner === first ? second : first;
  await winner.account.client.computer.revoke({ deviceId: winner.device.deviceId });
  await expect(
    loser.account.client.computer.confirm({ deviceId: loser.device.deviceId, slug }),
  ).rejects.toThrow("already reserved");
  await expect(
    runInDurableObject(deployment(), (_instance, state) => {
      state.storage.sql.exec("UPDATE computer SET slug=? WHERE id=?", slug, loser.device.deviceId);
    }),
  ).rejects.toThrow(/UNIQUE/);
});
it("expires or cancels pending confirmation without reserving its suggested slug", async () => {
  const first = await pending();
  await first.account.client.computer.revoke({ deviceId: first.device.deviceId });
  expect((await status(first.device.credential)).status).toBe(403);
  const second = await pending();
  vi.spyOn(Date, "now").mockReturnValue(second.device.expiresAt + 1);
  expect((await status(second.device.credential)).status).toBe(403);
  await expect(
    second.account.client.computer.confirm({ deviceId: second.device.deviceId, slug: "late" }),
  ).rejects.toThrow("expired");
});
