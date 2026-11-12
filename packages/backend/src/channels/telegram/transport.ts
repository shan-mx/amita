import type { channelConnection } from "@amita/db/schema";
import { type TelegramRawMessage } from "@chat-adapter/telegram";
import { z } from "zod";
import {
  ChannelError,
  type ChannelAttachment,
  type ChannelEndpoint,
  type ChannelFile,
} from "../adapter";
import { TelegramTextAdapter } from "./format";

const API_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 180_000;
const DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;

export const telegramUser = z.object({
  id: z.number().int(),
  is_bot: z.boolean(),
  first_name: z.string(),
  username: z.string().optional(),
  has_topics_enabled: z.boolean().optional(),
  allows_users_to_create_topics: z.boolean().optional(),
});
const telegramChat = z.object({
  id: z.number().int(),
  type: z.string(),
  first_name: z.string().optional(),
});
const telegramMessage = z.looseObject({
  message_id: z.number().int(),
  date: z.number().int(),
  chat: telegramChat,
  from: telegramUser.optional(),
  message_thread_id: z.number().int().optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  photo: z
    .array(z.object({ file_id: z.string(), file_size: z.number().nonnegative().optional() }))
    .optional(),
  document: z
    .object({
      file_id: z.string(),
      file_name: z.string().optional(),
      mime_type: z.string().optional(),
      file_size: z.number().nonnegative().optional(),
    })
    .optional(),
  reply_to_message: z
    .looseObject({
      message_id: z.number().int(),
      text: z.string().optional(),
      caption: z.string().optional(),
    })
    .optional(),
  quote: z.object({ text: z.string() }).optional(),
  forum_topic_created: z.object({ name: z.string() }).optional(),
  forum_topic_edited: z.object({ name: z.string().optional() }).optional(),
  forum_topic_closed: z.object({}).optional(),
  forum_topic_reopened: z.object({}).optional(),
});
export const telegramUpdate = z.object({
  update_id: z.number().int(),
  message: telegramMessage.optional(),
});
export type TelegramMessage = z.infer<typeof telegramMessage>;

const commands = [
  { command: "start", description: "Connect to Amita" },
  { command: "new", description: "Start a fresh context here" },
  { command: "stop", description: "Stop the conversation and clear queued requests" },
];

export function registerTelegramCommands(token: string) {
  return telegramApi(token, "setMyCommands", { commands });
}

export function telegramSupportsThreads(bot: z.infer<typeof telegramUser>) {
  return Boolean(bot.has_topics_enabled && bot.allows_users_to_create_topics);
}

export function telegramApi<T>(
  token: string,
  method: string,
  body: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  return telegramRequest(token, method, JSON.stringify(body), "application/json", signal);
}

async function telegramRequest<T>(
  token: string,
  method: string,
  body: BodyInit,
  contentType: string,
  signal?: AbortSignal,
  timeoutMs = API_TIMEOUT_MS,
): Promise<T> {
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), timeoutMs);
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": contentType },
      body,
      signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
    });
    const data = z
      .discriminatedUnion("ok", [
        z.object({ ok: z.literal(true), result: z.unknown() }),
        z.object({
          ok: z.literal(false),
          error_code: z.number().int(),
          description: z.string().optional(),
          parameters: z.object({ retry_after: z.number().nonnegative().optional() }).optional(),
        }),
      ])
      .parse(await response.json());
    if (response.ok && data.ok) return data.result as T;
    if (data.ok) throw new ChannelError("Telegram returned an invalid HTTP response.", "unknown");
    if (data.error_code === 429)
      throw new ChannelError(
        "Telegram rate limited this request.",
        "limited",
        (data.parameters?.retry_after ?? 1) * 1000,
      );
    throw new ChannelError(
      data.error_code === 401
        ? "Telegram rejected this bot token. Check the token and try again."
        : `Telegram rejected this request${data.description ? `: ${data.description.replaceAll(token, "[redacted]")}` : "."}`,
      response.status >= 500 ? "unknown" : "failed",
    );
  } catch (error) {
    if (error instanceof ChannelError) throw error;
    throw new ChannelError("Telegram delivery could not be confirmed.", "unknown");
  } finally {
    clearTimeout(timeout);
  }
}

const isPhoto = (file: ChannelFile) =>
  file.mediaType === "image/jpeg" || file.mediaType === "image/png";

async function sendFile(
  token: string,
  route: string,
  file: ChannelFile,
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
) {
  const [chatId, threadId] = JSON.parse(route) as [number, number | null];
  const photo = isPhoto(file);
  const boundary = `amita-${crypto.randomUUID()}`;
  const fields = [["chat_id", String(chatId)]];
  if (threadId !== null) fields.push(["message_thread_id", String(threadId)]);
  const encoder = new TextEncoder();
  const name = file.name.replace(/[\r\n"\\]/g, "_");
  const header = encoder.encode(
    fields
      .map(
        ([key, value]) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
      )
      .join("") +
      `--${boundary}\r\nContent-Disposition: form-data; name="${photo ? "photo" : "document"}"; filename="${name}"\r\nContent-Type: ${file.mediaType}\r\n\r\n`,
  );
  const footer = encoder.encode(`\r\n--${boundary}--\r\n`);
  const fixed = new FixedLengthStream(header.byteLength + file.size + footer.byteLength);
  const framing = new TransformStream<Uint8Array, Uint8Array>({
    start: (controller) => controller.enqueue(header),
    transform: (chunk, controller) => controller.enqueue(chunk),
    flush: (controller) => controller.enqueue(footer),
  });
  const transfer = new AbortController();
  const uploadSignal = signal ? AbortSignal.any([signal, transfer.signal]) : transfer.signal;
  const pipe = stream
    .pipeThrough(framing, { signal: uploadSignal })
    .pipeTo(fixed.writable, { signal: uploadSignal });
  void pipe.catch(() => {});
  try {
    const result = await telegramRequest<{ message_id: number }>(
      token,
      photo ? "sendPhoto" : "sendDocument",
      fixed.readable,
      `multipart/form-data; boundary=${boundary}`,
      uploadSignal,
      UPLOAD_TIMEOUT_MS,
    );
    return String(result.message_id);
  } finally {
    transfer.abort();
  }
}

export function telegramRoute(chatId: number, threadId?: number) {
  return JSON.stringify([chatId, threadId ?? null]);
}

export function parseTelegramInput(message: TelegramMessage, token: string, secret: string) {
  const adapter = new TelegramTextAdapter({
    botToken: token,
    secretToken: secret,
    mode: "webhook",
  });
  const { text } = adapter.parseMessage(message as unknown as TelegramRawMessage);
  const attachments: ChannelAttachment[] = [];
  const photo = message.photo?.at(-1);
  if (photo)
    attachments.push({
      locator: photo.file_id,
      name: "photo.jpg",
      mediaType: "image/jpeg",
      ...(photo.file_size === undefined ? {} : { size: photo.file_size }),
    });
  const document = message.document;
  if (document && !message.animation)
    attachments.push({
      locator: document.file_id,
      name: document.file_name || "attachment",
      mediaType: document.mime_type || "application/octet-stream",
      ...(document.file_size === undefined ? {} : { size: document.file_size }),
    });
  return { text, attachments };
}

export function telegram(connection: typeof channelConnection.$inferSelect): ChannelEndpoint {
  return {
    id: connection.id,
    platform: "telegram",
    label: `@${connection.config.username}`,
    name: connection.config.name,
    paired: connection.config.chatId !== null,
    status: connection.status,
    timezone: "UTC",
    supportsThreads: connection.config.topicsEnabled,
    threadCreationFailure: (unknown) =>
      unknown ? "Telegram did not confirm topic creation." : "Topic creation failed.",
    prepareText(text, kind) {
      return new TelegramTextAdapter({
        botToken: connection.config.token,
        secretToken: connection.config.secret,
        mode: "webhook",
        persistThreadHistory: false,
      }).prepareText(text, kind);
    },
    attachmentDownload: {
      maxBytes: DOWNLOAD_MAX_BYTES,
      async open(locator, signal) {
        const unavailable =
          "This attachment is no longer available. Ask the sender to upload it again.";
        try {
          const token = connection.config.token;
          const file = await telegramApi<{ file_path?: string }>(
            token,
            "getFile",
            { file_id: locator },
            signal,
          );
          const path = file.file_path?.split("/");
          if (
            !path?.length ||
            path.some((segment) => !segment || segment === "." || segment === "..")
          )
            throw new ChannelError(unavailable);
          const response = await fetch(
            `https://api.telegram.org/file/bot${token}/${path.map(encodeURIComponent).join("/")}`,
            { signal, redirect: "manual" },
          );
          if (!response.ok || !response.body) throw new ChannelError(unavailable);
          return response.body;
        } catch {
          signal?.throwIfAborted();
          throw new ChannelError(unavailable);
        }
      },
    },
    attachmentSend: {
      maxBytes: (file) => (isPhoto(file) ? PHOTO_MAX_BYTES : DOCUMENT_MAX_BYTES),
      send: (route, file, stream, signal) =>
        sendFile(connection.config.token, route, file, stream, signal),
    },
    async sendTyping(route, signal) {
      const [chatId, threadId] = JSON.parse(route) as [number, number | null];
      await telegramApi<boolean>(
        connection.config.token,
        "sendChatAction",
        { chat_id: chatId, message_thread_id: threadId ?? undefined, action: "typing" },
        signal,
      );
    },
    async sendText(route, text, signal) {
      const [chatId, threadId] = JSON.parse(route) as [number, number | null];
      const result = await telegramApi<{ message_id: number }>(
        connection.config.token,
        "sendMessage",
        {
          chat_id: chatId,
          message_thread_id: threadId ?? undefined,
          text,
          parse_mode: "MarkdownV2",
        },
        signal,
      );
      return String(result.message_id);
    },
    async renameThread(route, title, signal) {
      const [chatId, threadId] = JSON.parse(route) as [number, number | null];
      await telegramApi<boolean>(
        connection.config.token,
        "editForumTopic",
        {
          chat_id: chatId,
          message_thread_id: threadId,
          name: title,
        },
        signal,
      );
    },
    async createThread(route, title, signal) {
      const [chatId] = JSON.parse(route) as [number, number | null];
      const result = await telegramApi<{ message_thread_id: number; name: string }>(
        connection.config.token,
        "createForumTopic",
        { chat_id: chatId, name: title },
        signal,
      );
      return { route: telegramRoute(chatId, result.message_thread_id), label: result.name };
    },
  };
}
