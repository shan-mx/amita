import { createAgent } from "./helpers";
import { z } from "zod";
import type { Env } from "../src/env";
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { vi, expect } from "vite-plus/test";
import { codemodeToolCall, modelFixture, owner, WAIT } from "./helpers";

type TelegramTransportOptions = {
  onSend?: (body: Record<string, unknown>, count: number) => Response | undefined;
  onUpload?: (method: string) => Response | undefined;
  beforeWebhookWrite?: (botId: number) => Promise<void> | undefined;
  createTopic?: () => Promise<Response>;
  topicsEnabled?: () => boolean;
  file?: Uint8Array<ArrayBuffer> | ((signal: AbortSignal) => Response);
};

export function telegram(
  options: TelegramTransportOptions & {
    text?: string;
    model?: Parameters<typeof modelFixture>[0];
  } = {},
) {
  const model = modelFixture(async (body, signal) => {
    const listing = JSON.stringify(
      body.messages.findLast(({ role }) => role === "user")?.content,
    ).includes("CHANNEL_DIRECTORY_FIXTURE");
    const reply = (listing
      ? body.messages.some(({ role }) => role === "tool")
        ? { text: "Directory ready" }
        : { tool: { name: "channel_list", arguments: {} } }
      : await options.model?.(body, signal)) ?? {
      text: options.text ?? "TELEGRAM_ANSWER",
    };
    const tool = reply.tool;
    return tool &&
      ["automation", "channel_list", "channel_send", "channel_download"].includes(tool.name)
      ? { ...reply, tool: codemodeToolCall(tool.name, tool.arguments) }
      : reply;
  });
  const upstream = vi.mocked(fetch).getMockImplementation();
  if (!upstream) throw new Error("Model fixture transport is missing.");
  return { model, ...telegramTransport(options, upstream) };
}

export function telegramTransport(
  options: TelegramTransportOptions = {},
  upstream: typeof fetch = fetch,
) {
  const webhooks = new Map<string, { url: string; secret: string }>();
  const outbound: Array<{ chat_id?: unknown; message_thread_id?: unknown; text?: unknown }> = [];
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let nextTopicId = 500;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (resource, init) => {
    const request = new Request(resource, init);
    const url = new URL(request.url);
    if (url.hostname !== "api.telegram.org") return upstream(resource, init);
    if (url.pathname.startsWith("/file/")) {
      if (typeof options.file === "function") return options.file(request.signal);
      return options.file ? new Response(options.file) : new Response(null, { status: 404 });
    }
    const [, token, method] = url.pathname.split("/");
    const botId = Number(token.slice(3).split(":")[0]);
    const upload = method === "sendPhoto" || method === "sendDocument";
    const body = upload
      ? Object.fromEntries((await request.formData()).entries())
      : ((await request.json()) as Record<string, unknown>);
    calls.push({ method, body });
    if (method === "getFile" && options.file)
      return Response.json({ ok: true, result: { file_path: "documents/fixture.bin" } });
    if (method === "getMe") {
      return Response.json({
        ok: true,
        result: {
          id: botId,
          is_bot: true,
          first_name: "Fixture",
          username: `bot_${botId}`,
          has_topics_enabled: true,
          allows_users_to_create_topics: options.topicsEnabled?.() ?? false,
        },
      });
    }
    if (method === "getWebhookInfo") {
      return Response.json({ ok: true, result: { url: webhooks.get(token)?.url ?? "" } });
    }
    if (method === "setWebhook") {
      await options.beforeWebhookWrite?.(botId);
      webhooks.set(token, { url: String(body.url), secret: String(body.secret_token) });
    }
    if (method === "deleteWebhook") webhooks.delete(token);
    if (method === "createForumTopic") {
      if (options.createTopic) return options.createTopic();
      return Response.json({
        ok: true,
        result: { message_thread_id: nextTopicId++, name: body.name },
      });
    }
    if (method === "sendMessage") {
      outbound.push(body);
      const response = options.onSend?.(body, outbound.length);
      if (response) return response;
    }
    if (upload)
      return (
        options.onUpload?.(method) ??
        Response.json({ ok: true, result: { message_id: calls.length } })
      );
    return Response.json({
      ok: true,
      result: method === "sendMessage" ? { message_id: outbound.length } : true,
    });
  });
  const send = (
    connectionId: string,
    updateId: number,
    text: string | Record<string, unknown>,
    userId = 991,
    threadId?: number,
  ) => {
    const path = `https://amita.test/webhooks/telegram/${connectionId}`;
    const secret = [...webhooks.values()].find((webhook) => webhook.url === path)?.secret ?? "";
    return SELF.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
      body: JSON.stringify({
        update_id: updateId,
        message: {
          message_id: updateId,
          date: 1,
          message_thread_id: threadId,
          chat: { id: userId, type: "private", first_name: "Owner" },
          from: { id: userId, first_name: "Owner", is_bot: false },
          ...(typeof text === "string" ? { text } : text),
        },
      }),
    });
  };
  return { outbound, send, webhooks, calls };
}

export async function agent() {
  const browser = owner();
  await browser.login();
  const deployment = (env as unknown as Env).DEPLOYMENT.getByName("deployment");
  await runInDurableObject(deployment, (_instance, state) => {
    state.storage.sql.exec("DELETE FROM channel_connection");
    state.storage.kv.delete("channels.owner.telegram");
  });
  const { agent } = await createAgent(browser.client, { name: "Telegram fixture", persona: "" });
  return { client: browser.client, agentId: agent.id };
}

export function pairingCommand(url: string) {
  return `/start ${new URL(url).searchParams.get("start")}`;
}

export async function listDestinations(
  client: ReturnType<typeof owner>["client"],
  agentId: string,
) {
  const { id: sessionId } = await client.sessions.create({ agentId });
  const target = { agentId, sessionId };
  await client.sessions.submit({
    ...target,
    operationId: crypto.randomUUID(),
    text: "CHANNEL_DIRECTORY_FIXTURE",
  });
  const resultSchema = z.object({
    destinations: z.array(z.object({ id: z.string(), label: z.string(), canSend: z.boolean() })),
  });
  let destinations: z.infer<typeof resultSchema>["destinations"] = [];
  await vi.waitFor(async () => {
    const { entries } = await client.sessions.history(target);
    const result = entries
      .flatMap(({ model }) => model ?? [])
      .find((message) => message.role === "toolResult");
    if (result?.role !== "toolResult") throw new Error("Waiting for channel_list");
    expect(result.isError).toBe(false);
    const part = result.content[1];
    if (part?.type !== "text") throw new Error("Missing channel_list result");
    destinations = resultSchema.parse(JSON.parse(part.text)).destinations;
  }, WAIT);
  return destinations;
}
