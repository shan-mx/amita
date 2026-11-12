import type { ChatConnection } from "@amita/backend/types";

export function connectChat(
  origin: string,
  agentId: string,
  connection: ChatConnection,
): WebSocket {
  const url = new URL(`/api/events/${encodeURIComponent(agentId)}/${connection.session}`, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (connection.from !== undefined) url.searchParams.set("from", String(connection.from));
  return new WebSocket(url);
}
