import { expect, test, type WebSocketRoute } from "@playwright/test";
import { CONFIG } from "@amita/backend/config";

test("recovers an over-window transcript gap after the browser goes offline", async ({
  page,
  context,
}) => {
  const agentId = "transcript-fixture";
  const sessionId = "1";
  const pageSize = CONFIG.historyPageSize;
  const entries = Array.from({ length: pageSize * 3 + 2 }, (_, index) => ({
    id: index + 1,
    conversationId: 1,
    kind: "pi.user",
    model: [{ role: "user", content: `Message ${index + 1}`, timestamp: 0 }],
  }));
  let committed = 1;
  const watches: (string | null)[] = [];
  let connection: WebSocketRoute | undefined;
  const historyRequests: {
    minEntryId: number;
    maxEntryId: number;
    limit: number;
    order: string;
  }[] = [];
  await page.routeWebSocket("**/api/events/**", (socket) => {
    connection = socket;
    watches.push(new URL(socket.url()).searchParams.get("from"));
    const start = Math.max(0, committed - pageSize);
    const view = {
      conversation: { id: 1 },
      docs: {},
      entries: entries.slice(start, committed),
      ...(start > 0 ? { before: entries[start - 1].id } : {}),
    };
    socket.send(JSON.stringify({ type: "snapshot", view }));
  });
  try {
    await page.route("**/api/rpc/**", async (route) => {
      const procedure = new URL(route.request().url()).pathname.replace("/api/rpc/", "");
      const rpc = (value: unknown) => route.fulfill({ json: { json: value } });
      switch (procedure) {
        case "auth/status":
          return rpc({ configured: true, authenticated: true });
        case "providers/list":
          return rpc([
            { config: { kind: "builtin", id: "fixture", options: {} }, hasApiKey: true },
          ]);
        case "providers/catalog":
          return rpc([{ id: "fixture", name: "Fixture", fields: [] }]);
        case "providers/models":
          return rpc([
            { provider: "fixture", providerName: "Fixture", id: "fixture", name: "Fixture" },
          ]);
        case "agents/list":
          return rpc([{ id: agentId, slug: agentId, name: "Fixture", createdAt: 0 }]);
        case "sessions/list":
          return rpc([{ id: sessionId, title: "Recovery", archived: false, busy: false }]);
        case "computer/status":
          return rpc({ computers: [], pending: [] });
        case "sessions/history": {
          const input = route.request().postDataJSON().json;
          historyRequests.push(input);
          const range = entries.filter(
            ({ id }) => input.minEntryId <= id && id <= input.maxEntryId,
          );
          return rpc({
            entries: range.slice(0, input.limit),
            ...(range.length > input.limit ? { next: { more: true } } : {}),
          });
        }
        default:
          throw new Error(`Unexpected RPC: ${procedure}`);
      }
    });
    await page.goto("/");
    const messages = page.locator(".user-message");
    await expect(messages).toHaveText(["Message 1"]);
    expect(historyRequests).toHaveLength(0);

    await context.setOffline(true);
    await connection?.close();
    await expect(page.getByText("Reconnecting…", { exact: true })).toBeVisible();
    committed = entries.length;
    await context.setOffline(false);

    const gap = page.getByRole("button", { name: "Load missing messages" });
    await expect(gap).toBeVisible();
    expect(watches.at(-1)).toBe("2");
    expect(historyRequests).toHaveLength(0);
    await expect(messages).toHaveCount(pageSize + 1);
    for (let loaded = 0; loaded < 3; loaded++) await gap.click();
    await expect(gap).toHaveCount(0);
    await expect(messages).toHaveText(entries.map((entry) => entry.model[0].content));
    expect(
      historyRequests.map(({ minEntryId, limit, order }) => ({ minEntryId, limit, order })),
    ).toEqual(
      [2, pageSize + 2, pageSize * 2 + 2].map((minEntryId) => ({
        minEntryId,
        limit: pageSize,
        order: "ascending",
      })),
    );
  } finally {
    await context.setOffline(false);
    await page.unrouteAll({ behavior: "wait" });
  }
});
