import { expect, test, type Page, type Route, type WebSocketRoute } from "@playwright/test";
import { COPY } from "../../src/lib/copy";

type Input = { operationId: string; text: string };

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function chat(page: Page, submit: (route: Route, input: Input) => Promise<void>) {
  const sockets: WebSocketRoute[] = [];
  const inputs: Input[] = [];
  let model = { provider: "fixture", modelId: "fixture" };
  await page.routeWebSocket("**/api/events/**", (socket) => {
    sockets.push(socket);
    socket.send(
      JSON.stringify({
        type: "snapshot",
        view: { conversation: { id: 1 }, entries: [], docs: { "pi.agent": { model } } },
      }),
    );
  });
  await page.route("**/api/rpc/**", async (route) => {
    const procedure = new URL(route.request().url()).pathname.replace("/api/rpc/", "");
    const rpc = (value: unknown) => route.fulfill({ json: { json: value } });
    switch (procedure) {
      case "auth/status":
        return rpc({ configured: true, authenticated: true });
      case "providers/list":
        return rpc([{ config: { kind: "builtin", id: "fixture", options: {} }, hasApiKey: true }]);
      case "providers/catalog":
        return rpc([{ id: "fixture", name: "Fixture", fields: [] }]);
      case "providers/models":
        return rpc([
          { provider: "fixture", providerName: "Fixture", id: "fixture", name: "Fixture" },
          { provider: "fixture", providerName: "Fixture", id: "next", name: "Next model" },
        ]);
      case "agents/list":
        return rpc([
          { id: "submission-fixture", slug: "submission-fixture", name: "Fixture", createdAt: 0 },
        ]);
      case "sessions/list":
        return rpc([
          {
            id: "1",
            title: "Submission",
            archived: false,
            busy: false,
            model,
            modelEditable: true,
          },
        ]);
      case "sessions/setModel":
        model = route.request().postDataJSON().json.model;
        sockets[sockets.length - 1].send(
          JSON.stringify({ type: "delta", ops: [["s", ["docs", "pi.agent", "model"], model]] }),
        );
        return rpc({ updated: true });
      case "computer/status":
        return rpc({ computers: [], pending: [] });
      case "sessions/submit": {
        const input: Input = route.request().postDataJSON().json;
        inputs.push(input);
        return submit(route, input);
      }
      default:
        throw new Error(`Unexpected RPC: ${procedure}`);
    }
  });
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Message Fixture…" });
  await expect(draft).toBeVisible();
  return { inputs, sockets, draft, send: page.getByRole("button", { name: "Send", exact: true }) };
}

test("keeps failed input for manual retry without replaying on reconnect", async ({ page }) => {
  let attempts = 0;
  const { inputs, sockets, draft, send } = await chat(page, async (route) => {
    attempts++;
    if (attempts % 2 === 1) await route.abort("failed");
    else await route.fulfill({ json: { json: { accepted: true } } });
  });
  await draft.fill("Retry this message manually.");
  await send.click();
  await expect(page.getByText(COPY.requestFailed, { exact: true })).toBeVisible();
  await sockets[0].close();
  await expect.poll(() => sockets.length).toBe(2);
  await expect(page.getByText(COPY.reconnecting, { exact: true })).not.toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(inputs).toHaveLength(1);
  await expect(draft).toHaveValue("Retry this message manually.");

  await send.click();
  await expect(draft).toHaveValue("");
  expect(inputs).toHaveLength(2);
  expect(inputs[1]).toEqual(inputs[0]);

  await draft.fill("A different message.");
  await send.click();
  await expect(page.getByText(COPY.requestFailed, { exact: true })).toBeVisible();
  await expect(draft).toHaveValue("A different message.");
  await draft.fill("Edited before retrying.");
  await send.click();
  await expect(draft).toHaveValue("");
  expect(inputs[3].operationId).not.toBe(inputs[2].operationId);
  expect(inputs[3].text).toBe("Edited before retrying.");
});

test("preserves edits made while a submission is pending", async ({ page }) => {
  const release = deferred();
  const seen = deferred();
  const { draft, send } = await chat(page, async (route) => {
    seen.resolve();
    await release.promise;
    await route.fulfill({ json: { json: { accepted: true } } });
  });
  try {
    await draft.fill("Submit this first.");
    await send.click();
    await seen.promise;
    await draft.fill("Keep typing the next message.");
    release.resolve();
    await expect(send).toBeEnabled();
    await expect(draft).toHaveValue("Keep typing the next message.");
  } finally {
    release.resolve();
  }
});

test("keeps the draft and displays a model rejection", async ({ page }) => {
  const message = "Choose a model before sending.";
  const { draft, send } = await chat(page, async (route) => {
    await route.fulfill({
      status: 412,
      json: { json: { defined: false, code: "PRECONDITION_FAILED", status: 412, message } },
    });
  });
  await draft.fill("Send after model setup.");
  await send.click();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(draft).toHaveValue("Send after model setup.");
});

test("prevents model changes during a run and allows them after completion", async ({ page }) => {
  const { sockets } = await chat(page, async (route) =>
    route.fulfill({ json: { json: { accepted: true } } }),
  );
  const current = page.getByRole("combobox", { name: "Fixture / Fixture" });
  await expect(current).toBeEnabled();
  sockets[sockets.length - 1].send(
    JSON.stringify({
      type: "snapshot",
      view: {
        conversation: { id: 1 },
        entries: [],
        docs: {
          "pi.live": { run: { id: "running" } },
          "pi.agent": { model: { provider: "fixture", modelId: "fixture" } },
        },
      },
    }),
  );
  await expect(page.getByRole("textbox", { name: "Update current task…" })).toBeVisible();
  await expect(current).toBeDisabled();
  sockets[sockets.length - 1].send(
    JSON.stringify({
      type: "snapshot",
      view: {
        conversation: { id: 1 },
        entries: [],
        docs: { "pi.agent": { model: { provider: "fixture", modelId: "fixture" } } },
      },
    }),
  );
  await expect(current).toBeEnabled();
  await page.waitForLoadState("networkidle");
  await page.route("**/api/rpc/sessions/list", () => {
    throw new Error("A model-only change must not refresh all sessions");
  });
  await current.click();
  await page.getByRole("combobox", { name: "Search models…" }).fill("next");
  await page.getByRole("option", { name: "Next model" }).click();
  await expect(page.getByRole("combobox", { name: "Fixture / Next model" })).toBeVisible();
});
