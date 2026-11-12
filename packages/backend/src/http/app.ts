import { Hono } from "hono";
import { z } from "zod";
import { RPCHandler } from "@orpc/server/fetch";
import { onError, ORPCError } from "@orpc/server";
import { router } from "./router";
import { authenticate, configured, passwordMatches, sameOrigin } from "./auth";
import { directory } from "../deployment/directory";
import { CHAT_EXPIRES_AT_HEADER, COPY, CONFIG } from "../shared/config";
import type { Env } from "../env";
import { parseTelegramInput, telegramRoute, telegramUpdate } from "../channels/telegram/transport";
import type { ChannelInput } from "../channels/adapter";

const app = new Hono<{ Bindings: Env }>();
const handler = new RPCHandler(router, {
  clientInterceptors: [
    onError((error) => {
      if (error instanceof ORPCError && error.status < 500) return;
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      console.error(
        "RPC failed",
        cause instanceof Error
          ? { name: cause.name, message: cause.message, stack: cause.stack }
          : { type: typeof cause },
      );
    }),
  ],
});

app.use("/api/*", async (context, next) => {
  context.header("Cache-Control", "no-store");
  context.header("X-Content-Type-Options", "nosniff");
  const request = context.req.raw;
  if (!sameOrigin(request)) return context.json({ message: COPY.requestFailed }, 403);
  if (context.req.path.startsWith("/api/rpc/")) {
    if (request.method !== "POST") return context.json({ message: COPY.requestFailed }, 405);
    if (request.headers.get("Origin") !== new URL(request.url).origin)
      return context.json({ message: COPY.requestFailed }, 403);
    if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json")
      return context.json({ message: COPY.requestFailed }, 415);
  }
  await next();
});

app.all("/api/rpc/*", async (context) => {
  const headers = new Headers();
  const result = await handler.handle(context.req.raw, {
    prefix: "/api/rpc",
    context: { env: context.env, request: context.req.raw, headers },
  });
  if (!result.matched) return context.notFound();
  const response = new Response(result.response.body, result.response);
  headers.forEach((value, key) => response.headers.append(key, value));
  return response;
});

app.post("/webhooks/telegram/:connectionId", async (context) => {
  const deployment = directory(context.env);
  const { connectionId } = context.req.param();
  const secret = context.req.header("X-Telegram-Bot-Api-Secret-Token");
  const connection = await deployment.channelConnection(connectionId);
  if (
    !secret ||
    !connection?.config.webhookReady ||
    connection.status === "disconnected" ||
    !(await passwordMatches(secret, connection.config.secret))
  )
    return context.text("Forbidden", 403);
  const update = telegramUpdate.safeParse(await context.req.json().catch(() => null));
  if (!update.success) return context.text("Invalid Telegram update", 400);
  const message = update.data.message;
  if (!message) return context.text("OK");
  if (
    message.chat.type !== "private" ||
    !message.from ||
    message.from.is_bot ||
    message.from.id !== message.chat.id
  )
    return context.text("OK");
  const userId = String(message.from.id);
  const chatLabel = message.chat.first_name || message.from.first_name || "Private chat";
  const pairing = message.text?.match(/^\/start\s+([A-Za-z0-9_-]+)$/)?.[1];
  if (pairing) {
    const accepted = await deployment.channelsPair(
      connectionId,
      secret,
      pairing,
      userId,
      String(message.chat.id),
      String(update.data.update_id),
    );
    if (accepted)
      await context.env.AGENTS.getByName(connection.agentId).registerChannelChat(connectionId, {
        route: telegramRoute(message.chat.id),
        chatLabel,
      });
    return context.text("OK");
  }
  if (
    connection.config.chatId !== String(message.chat.id) ||
    (await deployment.channelOwner()) !== userId
  )
    return context.text("OK");
  const threadId = message.message_thread_id === 1 ? undefined : message.message_thread_id;
  const topicTitle = message.forum_topic_created?.name ?? message.forum_topic_edited?.name;
  let topicAvailable: boolean | undefined;
  if (message.forum_topic_closed) topicAvailable = false;
  if (message.forum_topic_reopened) topicAvailable = true;
  const command = message.text?.trim().match(/^\/([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  let control: ChannelInput["control"];
  if (threadId && (topicTitle !== undefined || topicAvailable !== undefined)) {
    control = {
      kind: "topic",
      ...(topicTitle ? { title: topicTitle } : {}),
      ...(topicAvailable === undefined ? {} : { available: topicAvailable }),
    };
  } else if (command) {
    control = {
      kind: "command",
      name: command[1].toLowerCase(),
      argument: command[2]?.trim() ?? "",
    };
  }
  if (!control && connection.status !== "connected") return context.text("OK");
  const { text, attachments } = control
    ? { text: "", attachments: [] }
    : parseTelegramInput(message, connection.config.token, secret);
  if (!control && !text.trim() && !attachments.length) return context.text("OK");
  const replied = message.reply_to_message;
  const quoted = message.quote?.text ?? replied?.text ?? replied?.caption;
  await context.env.AGENTS.getByName(connection.agentId).acceptChannelInput(connectionId, {
    key: String(update.data.update_id),
    route: telegramRoute(message.chat.id, threadId),
    label: threadId ? `Topic ${threadId}` : `@${connection.config.username}`,
    chatLabel,
    messageId: String(message.message_id),
    thread: threadId !== undefined,
    text,
    ...(replied
      ? { replyTo: { messageId: String(replied.message_id), ...(quoted ? { text: quoted } : {}) } }
      : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(control ? { control } : {}),
  });
  return context.text("OK");
});

app.post("/api/companion/register", async (context) => {
  if (!configured(context.env)) return context.json({ message: COPY.configuration }, 503);
  const input = z
    .object({
      code: z.string().min(1).max(128),
      name: z.string().trim().min(1).max(CONFIG.nameMaxLength),
    })
    .safeParse(await context.req.json().catch(() => null));
  if (!input.success) return context.json({ message: COPY.requestFailed }, 400);
  const result = await directory(context.env).registerComputer(input.data.code, input.data.name);
  return result
    ? context.json(result)
    : context.json({ message: "Registration code is invalid or expired." }, 403);
});

app.get("/api/companion/status", async (context) => {
  const credential = context.req
    .header("Authorization")
    ?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  const status = credential ? await directory(context.env).pairingStatus(credential) : null;
  return status ? context.json(status) : context.json({ message: COPY.pairingCancelled }, 403);
});

app.get("/api/companion/connect", async (context) => {
  const credential = context.req
    .header("Authorization")
    ?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  const computer = credential
    ? await directory(context.env).authenticateComputer(credential)
    : null;
  if (!computer)
    return context.json({ message: "Computer authorization is invalid or revoked." }, 403);
  return context.env.COMPUTERS.get(context.env.COMPUTERS.idFromName(computer.id)).fetch(
    context.req.raw,
  );
});

app.get("/api/events/:agent/:session", async (context) => {
  if (context.req.header("Upgrade")?.toLowerCase() !== "websocket")
    return context.json({ message: COPY.requestFailed }, 426);
  if (context.req.header("Origin") !== new URL(context.req.url).origin)
    return context.json({ message: COPY.requestFailed }, 403);
  if (!configured(context.env)) return context.json({ message: COPY.configuration }, 503);
  const login = await authenticate(context.req.raw, context.env);
  if (!login) return context.json({ message: COPY.expired }, 401);
  const { agent, session } = context.req.param();
  if (!/^[1-9][0-9]{0,15}$/.test(session) || !(await directory(context.env).hasAgent(agent)))
    return context.notFound();
  const from = context.req.query("from");
  if (from !== undefined && (!/^[1-9][0-9]*$/.test(from) || !Number.isSafeInteger(Number(from))))
    return context.json({ message: "Invalid transcript entry ID." }, 400);
  const url = new URL("https://agent.internal/events");
  url.searchParams.set("session", session);
  if (from !== undefined) url.searchParams.set("from", from);
  return context.env.AGENTS.getByName(agent).fetch(url, {
    headers: { Upgrade: "websocket", [CHAT_EXPIRES_AT_HEADER]: String(login.expiresAt) },
  });
});

app.all("/api/*", (context) => context.notFound());
app.all("*", (context) => context.env.ASSETS.fetch(context.req.raw));
app.onError(
  () =>
    new Response(JSON.stringify({ message: COPY.requestFailed }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    }),
);

export default app;
