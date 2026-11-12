import { useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rpc } from "@/lib/query";
import { apiErrorMessage } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormDialog } from "@/components/patterns/form-dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { InlineNotice } from "@/components/patterns/inline-notice";

type ChannelState = Awaited<ReturnType<typeof api.channels.list>>;
type ChannelConnection = ChannelState["connections"][number];

const statusLabels: Record<ChannelConnection["status"], string> = {
  pairing: "Waiting for pairing",
  connected: "Connected",
  disconnected: "Disconnected",
  attention: "Needs attention",
};

export function ChannelsDialog({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const [token, setToken] = useState("");
  const [pairing, setPairing] = useState<{
    connectionId: string;
    url: string;
    expiresAt: number;
  }>();
  const client = useQueryClient();
  const list = useQuery(
    rpc.channels.list.queryOptions({ input: { agentId }, refetchInterval: 5_000 }),
  );
  const operation = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: rpc.channels.list.key({ input: { agentId } }) }),
  });
  const state = list.data;
  const busy = operation.isPending;
  const failure = operation.error ?? list.error;
  const error = failure ? apiErrorMessage(failure) : undefined;
  const now = list.dataUpdatedAt;
  const createConnection = (event: FormEvent) => {
    event.preventDefault();
    operation.mutate(async () => {
      await api.channels.connect({ agentId, token: token.trim() });
      setToken("");
    });
  };
  const createPairing = (connection: ChannelConnection) => {
    operation.mutate(async () => {
      const result = await api.channels.pair({ agentId, id: connection.id });
      setPairing({ connectionId: connection.id, ...result });
    });
  };

  return (
    <FormDialog open onOpenChange={(value) => !value && onClose()} title="Channels" size="wide">
      <div className="max-h-[75dvh] space-y-5 overflow-y-auto pr-1">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Connect a Telegram bot to let this agent receive messages and reply in Telegram.
        </p>
        <form onSubmit={createConnection} className="space-y-3 rounded-xl border border-border p-4">
          <h2 className="text-sm font-medium">Connect Telegram bot</h2>
          <Field>
            <FieldLabel htmlFor="telegram-bot-token">Bot token</FieldLabel>
            <Input
              id="telegram-bot-token"
              type="password"
              autoComplete="off"
              required
              value={token}
              onChange={(event) => setToken(event.target.value)}
              disabled={busy}
            />
          </Field>
          <Button type="submit" size="sm" disabled={busy || !token.trim()}>
            Connect
          </Button>
        </form>
        {error && <InlineNotice>{error}</InlineNotice>}
        {!state && <p className="text-sm text-muted-foreground">Loading channel connections…</p>}
        {state?.connections.length === 0 && (
          <p className="text-sm text-muted-foreground">No Telegram bots connected.</p>
        )}
        {state?.connections.map((connection) => (
          <section key={connection.id} className="space-y-3 rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="truncate font-medium">
                  {connection.name || `@${connection.username}`}
                </h3>
                <p className="text-sm text-muted-foreground">@{connection.username} · Telegram</p>
              </div>
              <span className="text-xs text-muted-foreground">
                {statusLabels[connection.status]}
              </span>
            </div>
            {connection.error && <p className="text-sm text-destructive">{connection.error}</p>}
            {pairing?.connectionId === connection.id && (
              <div className="space-y-2 rounded-lg bg-muted p-3">
                <p className="text-sm">Open this link in Telegram to pair your account.</p>
                <a
                  className="break-all text-sm underline underline-offset-4"
                  href={pairing.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Telegram pairing link
                </a>
                <p className="text-xs text-muted-foreground">
                  Expires in {Math.max(0, Math.ceil((pairing.expiresAt - now) / 60_000))} minutes.
                </p>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {connection.webhookReady && connection.status !== "disconnected" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => createPairing(connection)}
                >
                  Pair account
                </Button>
              )}
              {connection.status !== "disconnected" && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      operation.mutate(() =>
                        api.channels.disconnect({ agentId, id: connection.id }),
                      )
                    }
                  >
                    Disconnect
                  </Button>
                </>
              )}
            </div>
          </section>
        ))}
      </div>
    </FormDialog>
  );
}
