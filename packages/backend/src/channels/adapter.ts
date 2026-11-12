export type ChannelStatus = "pairing" | "connected" | "disconnected" | "attention";

export type ChannelAttachment = {
  locator: string;
  name: string;
  mediaType: string;
  size?: number;
};

export type ChannelFile = { name: string; mediaType: string; size: number };

export type ChannelInput = {
  key: string;
  route: string;
  label: string;
  chatLabel: string;
  messageId: string;
  text: string;
  replyTo?: { messageId: string; text?: string };
  thread: boolean;
  attachments?: ChannelAttachment[];
  control?:
    | { kind: "command"; name: string; argument: string }
    | { kind: "topic"; title?: string; available?: boolean };
};

export class ChannelError extends Error {
  constructor(
    message: string,
    readonly kind: "failed" | "unknown" | "limited" = "failed",
    readonly retryAfterMs = 0,
  ) {
    super(message);
    this.name = "ChannelError";
  }
}

export interface ChannelEndpoint {
  id: string;
  platform: string;
  label: string;
  name: string;
  paired: boolean;
  status: ChannelStatus;
  timezone: string;
  supportsThreads: boolean;
  threadCreationFailure(unknown: boolean): string;
  prepareText(text: string, kind?: "tool"): string[];
  sendTyping?(route: string, signal?: AbortSignal): Promise<void>;
  sendText(route: string, text: string, signal?: AbortSignal): Promise<string>;
  attachmentDownload?: {
    maxBytes: number;
    open(locator: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  };
  attachmentSend?: {
    maxBytes(file: ChannelFile): number;
    send(
      route: string,
      file: ChannelFile,
      stream: ReadableStream<Uint8Array>,
      signal?: AbortSignal,
    ): Promise<string>;
  };
  renameThread?(route: string, title: string, signal?: AbortSignal): Promise<void>;
  createThread?(
    route: string,
    title: string,
    signal?: AbortSignal,
  ): Promise<{ route: string; label: string }>;
}
