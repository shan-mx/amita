import { test, expect, type Page } from "@playwright/test";

const agent = { id: "agent-a", slug: "agent-a", name: "Agent A", createdAt: 1 };
const session = { id: "1", title: "Session A", archived: false, busy: false };
const rpc = (json: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ json }),
});
async function shell(page: Page) {
  await page.routeWebSocket("**/api/events/**", (socket) =>
    socket.send(
      JSON.stringify({
        type: "snapshot",
        view: { conversation: { id: 1 }, entries: [], docs: {} },
      }),
    ),
  );
  await page.route("**/api/rpc/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/rpc/", "");
    switch (path) {
      case "auth/status":
        return route.fulfill(rpc({ configured: true, authenticated: true }));
      case "agents/list":
        return route.fulfill(rpc([agent]));
      case "sessions/list":
        return route.fulfill(rpc([session]));
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
      default:
        throw new Error(`Unexpected RPC: ${path}`);
    }
  });
}
async function openAgentMenu(page: Page, name: string) {
  await page.getByRole("button", { name: /Switch agent:/ }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

test("reopening Memory reads current data after dismissing an unfinished load", async ({
  page,
}) => {
  await shell(page);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let settled!: () => void;
  const oldResponse = new Promise<void>((resolve) => {
    settled = resolve;
  });
  let reads = 0;
  await page.route("**/agents/memory", async (route) => {
    const read = ++reads;
    if (read === 1) await gate;
    await route.fulfill(rpc({ memory: read === 1 ? "Old memory" : "Current memory" }));
    if (read === 1) settled();
  });
  try {
    await page.goto("/");
    await openAgentMenu(page, "Memory");
    await expect.poll(() => reads).toBe(1);
    await page.getByRole("button", { name: "Cancel", exact: true }).first().click();
    await openAgentMenu(page, "Memory");
    await expect(page.getByRole("textbox", { name: "Memory", exact: true })).toHaveValue(
      "Current memory",
    );
    finish();
    await oldResponse;
    await expect(page.getByRole("textbox", { name: "Memory", exact: true })).toHaveValue(
      "Current memory",
    );
  } finally {
    finish();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("Automation polling retains older runs and late saves leave the selected editor alone", async ({
  page,
}) => {
  await shell(page);
  const automations = ["A", "B"].map((name) => ({
    id: name,
    definition: {
      name: `Automation ${name}`,
      trigger: { type: "cron", expression: "0 9 * * *" },
      timezone: "UTC",
      script: "return 1;",
      prompt: null,
      model: null,
      enabled: true,
    },
    nextRun: null,
    activeRun: null,
  }));
  let firstPageReads = 0;
  await page.route("**/automations/list", (route) => route.fulfill(rpc(automations)));
  await page.route("**/automations/options", (route) => route.fulfill(rpc({ models: [] })));
  await page.route("**/automations/history", (route) => {
    const input = route.request().postDataJSON().json;
    if (!input.cursor) firstPageReads++;
    return route.fulfill(
      rpc({
        runs: [
          {
            id: input.cursor ?? "new",
            automationId: input.id,
            status: "succeeded",
            admittedAt: 1,
            output: `${input.id} ${input.cursor ? "older" : "newest"} run`,
          },
        ],
        cursor: input.cursor ? undefined : "older",
      }),
    );
  });
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let saving = false;
  await page.route("**/automations/update", async (route) => {
    saving = true;
    await gate;
    await route.fulfill(rpc(automations[0]));
  });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Automations", exact: true }).click();
    await expect(page.getByText("A newest run", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Load older runs", exact: true }).click();
    await expect(page.getByText("A older run", { exact: true })).toBeVisible();
    await expect.poll(() => firstPageReads, { timeout: 8000 }).toBeGreaterThan(1);
    await expect(page.getByText("A older run", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Edit automation", exact: true }).click();
    await page.getByRole("button", { name: "Save automation", exact: true }).click();
    await expect.poll(() => saving).toBe(true);
    await page.getByRole("button", { name: /Automation B/ }).click();
    const saved = page.waitForResponse("**/automations/update");
    finish();
    await saved;
    await expect(page.getByRole("heading", { name: "Automation B", exact: true })).toBeVisible();
    await expect(page.getByText("B newest run", { exact: true })).toBeVisible();
    await expect(page.getByText("A older run", { exact: true })).toHaveCount(0);
  } finally {
    finish();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("offline session creation fails immediately and only retries on another click", async ({
  page,
  context,
}) => {
  await shell(page);
  let creates = 0;
  await page.route("**/sessions/create", (route) => {
    creates++;
    return creates === 1
      ? route.abort("internetdisconnected")
      : route.fulfill(rpc({ ...session, id: "2" }));
  });
  await page.goto("/");
  await expect(page.getByLabel("Message Agent A…")).toBeVisible();
  await context.setOffline(true);
  await page.getByRole("button", { name: "New session", exact: true }).first().click();
  await expect(
    page.getByText("The request failed. Please try again.", { exact: true }),
  ).toBeVisible();
  expect(creates).toBe(1);
  await context.setOffline(false);
  await page.getByRole("button", { name: "New session", exact: true }).first().click();
  await expect.poll(() => creates).toBe(2);
  await expect(
    page.getByRole("button", { name: "New session", exact: true }).first(),
  ).toBeEnabled();
});

test("Providers opens the fresh configuration after initial data was cached", async ({ page }) => {
  await shell(page);
  let reads = 0;
  await page.route("**/providers/list", (route) => {
    const name = ++reads === 1 ? "Old provider" : "Current provider";
    return route.fulfill(
      rpc([
        {
          config: {
            kind: "custom",
            id: "custom-fixture",
            name,
            baseUrl: "https://fixture.test/v1",
            api: "openai-completions",
            models: [],
          },
          hasApiKey: true,
        },
      ]),
    );
  });
  await page.goto("/");
  await expect(page.getByLabel("Message Agent A…")).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("menuitem", { name: "Providers", exact: true }).click();
  await expect.poll(() => reads).toBe(2);
  await expect(page.getByRole("button", { name: "Current provider", exact: true })).toBeVisible();
});

test("Memory cannot replace the file after its fresh read fails", async ({ page }) => {
  await shell(page);
  let reads = 0;
  await page.route("**/agents/memory", (route) =>
    ++reads === 1 ? route.fulfill(rpc({ memory: "Cached old memory" })) : route.abort("failed"),
  );
  await page.goto("/");
  await openAgentMenu(page, "Memory");
  await expect(page.getByRole("textbox", { name: "Memory", exact: true })).toHaveValue(
    "Cached old memory",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).first().click();
  await openAgentMenu(page, "Memory");
  await expect(
    page.getByText("The request failed. Please try again.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Save memory", exact: true })).toBeDisabled();
});

test("Persona requires a successful fresh read before saving", async ({ page }) => {
  await shell(page);
  let reads = 0;
  await page.route("**/agents/persona", (route) =>
    ++reads === 1
      ? route.fulfill(rpc({ persona: "Cached persona", version: "old-version" }))
      : route.abort("failed"),
  );
  await page.goto("/");
  await openAgentMenu(page, "Agent settings");
  await expect(page.getByLabel("Persona", { exact: true })).toHaveValue("Cached persona");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await openAgentMenu(page, "Agent settings");
  await expect(page.getByRole("alert")).toContainText("The request failed. Please try again.");
  await expect(page.getByRole("button", { name: "Save persona", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Reload latest", exact: true })).toBeVisible();
});

test("Channels keeps an operation error visible after list polling succeeds", async ({ page }) => {
  await shell(page);
  let reads = 0;
  await page.route("**/channels/list", (route) => {
    reads++;
    return route.fulfill(rpc({ connections: [], ownerLinked: false }));
  });
  await page.route("**/channels/connect", (route) =>
    route.fulfill({
      ...rpc({ defined: false, code: "BAD_REQUEST", status: 400, message: "Invalid bot token" }),
      status: 400,
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await page.getByLabel("Bot token").fill("123:test");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const error = page.getByText("Invalid bot token", { exact: true });
  await expect(error).toBeVisible();
  const previous = reads;
  await expect.poll(() => reads, { timeout: 8_000 }).toBeGreaterThan(previous);
  await expect(error).toBeVisible();
});
