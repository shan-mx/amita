import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { FileTransfers, type FileRequest } from "./file-transfer";
import { CONFIG } from "../shared/config";
import {
  COMPANION_PROTOCOL,
  EXPIRED_BEFORE_START,
  REMOTE_METHODS,
  remoteErrorCode,
  interruptedOperation,
  type CancelReason,
  type RemoteError,
  type RemoteFrame,
  type RemoteOutput,
  type RemoteRequest,
} from "../shared/companion";
import type { Env } from "../env";

const operationSchema = z.object({
  id: z.string().min(1).max(256),
  method: z.enum(REMOTE_METHODS),
  params: z.record(z.string(), z.unknown()),
  workspace: z.string().min(1).optional(),
  deadline: z.number().finite().optional(),
});
const frameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("output"),
    id: z.string(),
    seq: z.number().int().positive(),
    stream: z.enum(["stdout", "stderr"]),
    text: z.string(),
    snapshot: z.literal(true),
    before: z.object({
      bytes: z.number().int().nonnegative(),
      newlines: z.number().int().nonnegative(),
      endsWithNewline: z.boolean(),
    }),
  }),
  z.object({
    type: z.literal("result"),
    id: z.string(),
    seq: z.number().int().positive(),
    result: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), value: z.unknown() }),
      z.object({
        ok: z.literal(false),
        error: z.object({
          code: z.string().transform((code) => remoteErrorCode.safeParse(code).data ?? "unknown"),
          message: z.string(),
          path: z.string().optional(),
          spillPath: z.string().optional(),
        }),
      }),
    ]),
  }),
]);
type Attachment = {
  connection: string;
  protocol?: number;
  seenAt: number;
  cwd?: string;
  home?: string;
};

type Operation = {
  id: string;
  method: string;
  socket?: WebSocket;
  cancelReason?: CancelReason;
  controller: ReadableStreamDefaultController<Uint8Array>;
  timer?: ReturnType<typeof setTimeout>;
  settle(): void;
  latest?: RemoteOutput;
  result?: RemoteFrame;
  cursor: number;
  closed: boolean;
};

const encoder = new TextEncoder();
const offline: RemoteError = {
  code: "computer_offline",
  message: "The Computer is offline. The operation did not run.",
};
const revoked: RemoteError = {
  code: "aborted",
  message: "Computer authorization was revoked.",
};
const META_KEYS = {
  connection: "connection",
  cwd: "cwd",
  home: "home",
  revoked: "revoked",
};

function encode(frame: RemoteFrame) {
  return encoder.encode(JSON.stringify(frame) + "\n");
}

function failed(id: string, error: RemoteError, seq = 1): RemoteFrame {
  return { type: "result", id, seq, result: { ok: false, error } };
}

/** Forwards operations over the current authenticated Companion connection. */
export class Computer extends DurableObject<Env> {
  private readonly files = new FileTransfers((frame) => {
    const socket = this.socket();
    if (socket) this.send(socket, frame);
  });
  private readonly metadata = this.ctx.storage.kv;
  private readonly pending = new Map<string, Operation>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private socket() {
    const connection = this.metadata.get<string>(META_KEYS.connection);
    return this.ctx
      .getWebSockets()
      .find(
        (ws) =>
          ws.readyState === WebSocket.OPEN && ws.deserializeAttachment()?.connection === connection,
      );
  }

  private online(socket: WebSocket, attachment: Attachment | undefined) {
    if (attachment?.protocol !== COMPANION_PROTOCOL) return false;
    const heartbeat = this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0;
    return Date.now() - Math.max(attachment.seenAt, heartbeat) < CONFIG.computerHeartbeatLeaseMs;
  }

  status() {
    const socket = this.socket();
    const attachment = socket?.deserializeAttachment() as Attachment | undefined;
    return {
      online: socket !== undefined && this.online(socket, attachment),
      cwd: attachment?.cwd ?? this.metadata.get<string>(META_KEYS.cwd) ?? "~",
      home: attachment?.home ?? this.metadata.get<string>(META_KEYS.home) ?? "~",
    };
  }

  openFileTransfer(request: FileRequest, content?: ReadableStream<Uint8Array>) {
    if (!this.status().online) throw new Error("The Computer is offline.");
    return this.files.open(request, content);
  }

  async fetch(request: Request) {
    if (this.metadata.get<boolean>(META_KEYS.revoked))
      return new Response("Connection revoked", { status: 403 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("WebSocket required", { status: 426 });
    await this.files.close();
    for (const old of this.ctx.getWebSockets()) {
      this.detach(old);
      old.close(4000, "Connection replaced");
    }
    const pair = new WebSocketPair();
    const connection = crypto.randomUUID();
    this.metadata.put(META_KEYS.connection, connection);
    const attachment: Attachment = { connection, seenAt: Date.now() };
    pair[1].serializeAttachment(attachment);
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (ws !== this.socket() || this.metadata.get<boolean>(META_KEYS.revoked)) return;
    try {
      const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
      const data = JSON.parse(raw);
      const attachment = ws.deserializeAttachment() as Attachment;
      if (attachment.protocol !== COMPANION_PROTOCOL) {
        const hello = z
          .object({
            type: z.literal("hello"),
            protocol: z.literal(COMPANION_PROTOCOL),
            os: z.enum(["darwin", "linux"]),
            name: z.string(),
            cwd: z.string().min(1),
            home: z.string().min(1),
          })
          .parse(data);
        attachment.protocol = hello.protocol;
        attachment.seenAt = Date.now();
        attachment.cwd = hello.cwd;
        attachment.home = hello.home;
        ws.serializeAttachment(attachment);
        this.metadata.put(META_KEYS.cwd, hello.cwd);
        this.metadata.put(META_KEYS.home, hello.home);
        ws.send(JSON.stringify({ type: "ready" }));
        for (const operation of this.pending.values()) {
          if (operation.socket || operation.method !== "exec") continue;
          operation.socket = ws;
          if (operation.cancelReason) this.sendCancel(operation);
          else if (
            !this.send(ws, {
              type: "resume",
              id: operation.id,
              after: operation.latest?.seq ?? 0,
            })
          )
            this.detach(ws);
        }
        return;
      }
      if (data.type === "file_chunk" || data.type === "file_result") {
        await this.files.receive(data, raw);
        return;
      }
      const frame = frameSchema.parse(data);
      const operation = this.pending.get(frame.id);
      if (!operation || operation.socket !== ws || frame.seq <= (operation.latest?.seq ?? 0))
        return;
      if (frame.type === "result") {
        this.finish(operation, frame);
        return;
      }
      if (
        operation.method !== "exec" ||
        encoder.encode(frame.text).byteLength > CONFIG.computerOutputSnapshotMaxBytes
      ) {
        throw new Error("Invalid output snapshot");
      }
      operation.latest = frame;
      this.pump(operation);
    } catch {
      this.detach(ws);
      ws.close(1003, "Invalid Companion protocol");
    }
  }

  async webSocketClose(ws: WebSocket) {
    if (ws.deserializeAttachment()?.connection === this.metadata.get(META_KEYS.connection))
      await this.files.close();
    this.detach(ws);
    ws.close(1000, "Connection closed");
  }

  async webSocketError(ws: WebSocket) {
    if (ws.deserializeAttachment()?.connection === this.metadata.get(META_KEYS.connection))
      await this.files.close();
    this.detach(ws);
    ws.close(1011, "Connection interrupted");
  }

  private detach(ws: WebSocket) {
    for (const operation of this.pending.values()) {
      if (operation.socket !== ws) continue;
      operation.socket = undefined;
      if (operation.method !== "exec") this.interrupt(operation);
    }
  }

  private send(ws: WebSocket, frame: object) {
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  async open(input: RemoteRequest): Promise<ReadableStream<Uint8Array>> {
    const request = operationSchema.parse(input);
    const id = request.id;
    if (this.metadata.get<boolean>(META_KEYS.revoked)) return this.resultStream(id, revoked);
    const socket = this.socket();
    if (!socket || !this.online(socket, socket.deserializeAttachment()))
      return this.resultStream(id, offline);
    const remaining = request.deadline === undefined ? undefined : request.deadline - Date.now();
    if (remaining !== undefined && remaining <= 0)
      return this.resultStream(id, {
        code: EXPIRED_BEFORE_START,
        message: "The operation deadline expired before execution.",
      });
    if (this.pending.has(id)) throw new Error("Execution ID is already active.");

    let operation: Operation;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        let settle!: () => void;
        this.ctx.waitUntil(
          new Promise<void>((resolve) => {
            settle = resolve;
          }),
        );
        const timer =
          remaining === undefined
            ? undefined
            : setTimeout(() => {
                if (operation.socket)
                  this.send(operation.socket, { type: "cancel", id, reason: "timeout" });
                this.interrupt(operation);
              }, remaining);
        operation = {
          id,
          method: request.method,
          socket,
          controller,
          timer,
          settle,
          cursor: 0,
          closed: false,
        };
        this.pending.set(id, operation);
        if (!this.send(socket, { type: "execute", ...request })) this.interrupt(operation);
      },
      pull: () => this.pump(operation),
      cancel: () => {
        operation.closed = true;
        this.cancel(id, "aborted");
      },
    });
  }

  private resultStream(id: string, error: RemoteError) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode(failed(id, error)));
        controller.close();
      },
    });
  }

  private interrupt(operation: Operation) {
    this.finish(
      operation,
      failed(
        operation.id,
        interruptedOperation(operation.method),
        (operation.latest?.seq ?? 0) + 1,
      ),
    );
  }

  private finish(operation: Operation, frame: RemoteFrame) {
    clearTimeout(operation.timer);
    this.pending.delete(operation.id);
    operation.settle();
    operation.result = frame;
    this.pump(operation);
  }

  private pump(operation: Operation) {
    if (operation.closed) return;
    const { controller, latest, result } = operation;
    if ((controller.desiredSize ?? 0) <= 0) return;
    if (latest && latest.seq > operation.cursor) {
      operation.cursor = latest.seq;
      controller.enqueue(encode(latest));
    }
    if (result && !operation.closed && (controller.desiredSize ?? 0) > 0) {
      operation.closed = true;
      controller.enqueue(encode(result));
      controller.close();
    }
  }

  cancel(id: string, reason: CancelReason) {
    const operation = this.pending.get(id);
    if (operation && !operation.cancelReason) {
      operation.cancelReason = reason;
      this.sendCancel(operation);
    }
  }

  private sendCancel(operation: Operation) {
    const socket = operation.socket;
    const result = failed(
      operation.id,
      { code: "aborted", message: "Remote operation cancellation was requested." },
      (operation.latest?.seq ?? 0) + 1,
    );
    if (
      socket &&
      this.send(socket, { type: "cancel", id: operation.id, reason: operation.cancelReason })
    ) {
      this.finish(operation, result);
    } else if (operation.method !== "exec") {
      this.interrupt(operation);
    } else {
      operation.socket = undefined;
      clearTimeout(operation.timer);
      operation.settle();
      operation.result = result;
      this.pump(operation);
    }
  }

  async revoke() {
    this.metadata.put(META_KEYS.revoked, true);
    await this.files.close();
    for (const operation of this.pending.values()) {
      if (operation.socket)
        this.send(operation.socket, { type: "cancel", id: operation.id, reason: "revoked" });
      this.finish(operation, failed(operation.id, revoked, (operation.latest?.seq ?? 0) + 1));
    }
    for (const ws of this.ctx.getWebSockets()) ws.close(4003, "Computer authorization revoked");
  }
}
