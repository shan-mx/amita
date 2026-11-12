import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import { SessionMetadata } from "./session-metadata";
import { CHAT_LOGIN_EXPIRED, CONFIG } from "../shared/config";
import type { ChatSubscription, ChatConnection, StreamPacket } from "../shared/types";

export class ChatConnections {
  private readonly subscriptions = new Map<WebSocket, () => void>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly pi: () => Promise<Harness>,
    private readonly conversation: (session: string) => Promise<Conversation>,
  ) {}

  async connect(connection: ChatConnection, expiresAt: number) {
    const pair = new WebSocketPair();
    const socket = pair[1];
    this.state.acceptWebSocket(socket);
    const subscription: ChatSubscription = { ...connection, expiresAt };
    socket.serializeAttachment(subscription);
    try {
      await this.subscribe(socket, subscription);
    } catch (error) {
      this.close(socket, 1011);
      throw error;
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async restore() {
    await Promise.all(
      this.state.getWebSockets().map(async (socket) => {
        try {
          const subscription = socket.deserializeAttachment() as ChatSubscription | null;
          if (subscription) await this.subscribe(socket, subscription);
        } catch (error) {
          this.close(socket, 1011);
          console.error("Could not restore chat subscription", error);
        }
      }),
    );
  }

  disconnect(socket: WebSocket) {
    const stop = this.subscriptions.get(socket);
    this.subscriptions.delete(socket);
    stop?.();
  }

  private close(socket: WebSocket, code: number) {
    this.disconnect(socket);
    if (socket.readyState === WebSocket.OPEN) socket.close(code);
  }

  private async subscribe(socket: WebSocket, { session, from, expiresAt }: ChatSubscription) {
    const open = () => {
      if (socket.readyState !== WebSocket.OPEN) return false;
      if (expiresAt > Date.now()) return true;
      this.close(socket, CHAT_LOGIN_EXPIRED);
      return false;
    };
    if (!open()) return;

    const conversation = await this.conversation(session);
    await conversation.commit(async (tx) => {
      await tx.doc(SessionMetadata, conversation.id);
    }, BG);
    const pi = await this.pi();
    const metadata = await pi.watchDoc(SessionMetadata, conversation.id, BG);
    const watch = await conversation
      .watch(BG, { min: CONFIG.historyPageSize, from })
      .catch((error) => {
        void metadata?.stop();
        throw error;
      });
    this.subscriptions.set(socket, () => {
      void watch.stop();
      void metadata?.stop();
    });
    const send = (packet: StreamPacket) => {
      if (!open()) {
        this.disconnect(socket);
        return false;
      }
      try {
        socket.send(JSON.stringify(packet));
        return true;
      } catch {
        this.close(socket, 1011);
        return false;
      }
    };
    if (!send({ type: "snapshot", view: watch.value })) return;
    watch.start(async (call) => {
      if (call.kind === "value") send({ type: "delta", ops: call.ops });
    });
    let title = metadata?.value?.title;
    metadata?.start(async (call) => {
      if (call.kind !== "value" || call.value.title === title) return;
      title = call.value.title;
      send({ type: "session_changed" });
    });
    const onClosed = () => {
      if (this.subscriptions.has(socket)) this.close(socket, 1011);
    };
    void watch.closed.then(onClosed, onClosed);
  }
}
