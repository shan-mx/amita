import { test, expect } from "@playwright/test";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const rpc = (value: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ json: value }),
});
const agents = ["A", "B"].map((name) => ({
  id: `agent-${name.toLowerCase()}`,
  slug: `agent-${name.toLowerCase()}`,
  name: `Agent ${name}`,
  createdAt: 1,
}));
const sessions = ["A", "B"].map((name, index) => ({
  id: String(index + 1),
  title: `Session ${name}`,
  archived: false,
  busy: false,
}));

test("switching Agent keeps its sessions when a previous Chat submit completes", async ({
  page,
}) => {
  const submitGate = deferred();
  const bListGate = deferred();
  const submitSeen = deferred();
  const bListSeen = deferred();
  const initialMessage = "Existing chat message";
  const historyRequests: string[] = [];
  await page.routeWebSocket("**/api/events/**", (socket) => {
    socket.send(
      JSON.stringify({
        type: "snapshot",
        view: {
          conversation: { id: 1 },
          entries: [
            {
              id: 1,
              conversationId: 1,
              kind: "pi.user",
              model: [{ role: "user", content: initialMessage, timestamp: 0 }],
            },
          ],
          docs: {},
        },
      }),
    );
  });
  try {
    await page.route("**/api/rpc/**", async (route) => {
      const procedure = new URL(route.request().url()).pathname.replace("/api/rpc/", "");
      const input = route.request().postDataJSON()?.json;
      switch (procedure) {
        case "auth/status":
          return route.fulfill(rpc({ configured: true, authenticated: true }));
        case "providers/list":
          return route.fulfill(
            rpc([{ config: { kind: "builtin", id: "fixture", options: {} }, hasApiKey: true }]),
          );
        case "providers/catalog":
          return route.fulfill(rpc([{ id: "fixture", name: "Fixture", fields: [] }]));
        case "providers/models":
          return route.fulfill(
            rpc([{ provider: "fixture", providerName: "Fixture", id: "fixture", name: "Fixture" }]),
          );
        case "agents/list":
          return route.fulfill(rpc(agents));
        case "computer/status":
          return route.fulfill(rpc({ computers: [], pending: [] }));
        case "sessions/history":
          historyRequests.push(input.sessionId);
          return route.fulfill(rpc({ entries: [] }));
        case "sessions/list":
          if (input.agentId === agents[1].id) {
            bListSeen.resolve();
            await bListGate.promise;
            return route.fulfill(rpc([sessions[1]]));
          }
          return route.fulfill(rpc([sessions[0]]));
        case "sessions/submit":
          submitSeen.resolve();
          await submitGate.promise;
          return route.fulfill(rpc({ accepted: true }));
        default:
          throw new Error(`Unexpected RPC: ${procedure}`);
      }
    });
    await page.goto("/");
    await expect(page.locator(".user-message")).toHaveText(initialMessage);
    await page.getByLabel("Message Agent A…").fill("Submit before switching agents.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await submitSeen.promise;
    await page.getByRole("button", { name: "Switch agent" }).click();
    await page.getByRole("menuitem", { name: /Agent B/ }).click();
    await bListSeen.promise;
    const submitted = page.waitForResponse((response) =>
      response.url().endsWith("/sessions/submit"),
    );
    submitGate.resolve();
    await (await submitted).finished();
    // Let the completed submit's browser callback run while B's list is still pending.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    bListGate.resolve();
    await expect(page.getByRole("button", { name: "Session B", exact: true })).toBeVisible();
    await expect(page.getByLabel("Message Agent B…")).toBeVisible();
    await expect(page.getByRole("button", { name: "Session A", exact: true })).toHaveCount(0);
    expect(historyRequests).toEqual([]);
  } finally {
    submitGate.resolve();
    bListGate.resolve();
    await page.unrouteAll({ behavior: "wait" });
  }
});
