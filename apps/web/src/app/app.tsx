import { useState } from "react";
import { match, P } from "ts-pattern";
import { Ellipsis, Menu, Plus, SquarePen } from "lucide-react";
import { COPY } from "@/lib/copy";
import { MODEL_COPY } from "@/features/models/copy";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { rpc } from "@/lib/query";
import { ProvidersDialog } from "@/features/models/providers-dialog";
import { Chat } from "@/features/chat/chat";
import { SignIn } from "@/features/auth/sign-in";
import { useAuth } from "@/features/auth/use-auth";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SheetTrigger } from "@/components/ui/sheet";
import { IconButton } from "@/components/patterns/icon-button";
import { InlineNotice } from "@/components/patterns/inline-notice";
import { AppShell } from "./app-shell";
import { Sidebar } from "./sidebar";
import { useNavigation } from "./use-navigation";
import { useOverlays } from "./use-overlays";

export function App() {
  const auth = useAuth();
  if (!auth.status)
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <div className="space-y-5">
          <Logo />
          <Skeleton className="h-2 w-32" />
          {auth.error && <InlineNotice>{auth.error}</InlineNotice>}
        </div>
      </main>
    );
  if (!auth.status.authenticated)
    return (
      <SignIn configured={auth.status.configured} notice={auth.notice} onLogin={auth.signedIn} />
    );
  return <OwnerApp auth={auth} />;
}

function OwnerApp({ auth }: { auth: ReturnType<typeof useAuth> }) {
  const navigation = useNavigation();
  const client = useQueryClient();
  const [drawer, setDrawer] = useState(false);
  const modelsQuery = useQuery(rpc.providers.list.queryOptions());
  const models = modelsQuery.data;
  const [modelsOpen, setModelsOpen] = useState<boolean>();
  const showModels = modelsOpen ?? models?.length === 0;
  const overlays = useOverlays(navigation, () => setDrawer(false));
  const {
    agents,
    agent,
    sessions,
    selection,
    archived,
    agentsLoaded,
    sessionsLoaded,
    selectedSession,
    creatingSession,
    archivingSessionId,
  } = navigation;
  const error = auth.error ?? navigation.error;
  const emptySessionsLabel = archived ? "No archived sessions" : "No sessions";
  const modelSetupNeeded = models?.length === 0;
  const openModelSettings = () => {
    void client.invalidateQueries({ queryKey: rpc.providers.list.key() });
    setModelsOpen(true);
  };
  const newSession = () => navigation.newSession(() => setDrawer(false));

  const sidebar = (
    <Sidebar
      agents={agents}
      agent={agent}
      sessions={sessions}
      sessionId={selection.sessionId}
      archived={archived}
      creatingSession={creatingSession}
      archivingSessionId={archivingSessionId}
      actions={{
        selectAgent: (id) => {
          navigation.selectAgent(id);
          setDrawer(false);
        },
        newAgent: overlays.newAgent,
        agentSettings: overlays.agentSettings,
        memory: overlays.memory,
        newSession,
        search: overlays.search,
        automations: overlays.automations,
        channels: overlays.channels,
        toggleArchived: navigation.toggleArchived,
        selectSession: (id) => {
          navigation.selectSession(id);
          setDrawer(false);
        },
        renameSession: overlays.session,
        archiveSession: navigation.archiveSession,
        computer: overlays.computer,
        modelSettings: openModelSettings,
        signOut: () => {
          setDrawer(false);
          auth.logout();
        },
        close: () => setDrawer(false),
      }}
    />
  );
  const header = (
    <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border/70 px-2 md:gap-2 md:px-6">
      <SheetTrigger render={<IconButton className="md:hidden" aria-label="Open sidebar" />}>
        <Menu />
      </SheetTrigger>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {agent && selectedSession && (
          <>
            <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground md:hidden">
              {agent.name}
            </span>
            <span className="text-muted-foreground md:hidden" aria-hidden="true">
              /
            </span>
          </>
        )}
        <h1 className="truncate text-sm font-semibold" title={selectedSession?.title}>
          {selectedSession?.title ?? agent?.name ?? "Amita"}
        </h1>
      </div>
      {agent && (
        <div className="flex shrink-0 items-center md:hidden">
          {selectedSession && (
            <IconButton aria-label="Session settings" onClick={() => overlays.session()}>
              <Ellipsis />
            </IconButton>
          )}
          <IconButton aria-label={COPY.newSession} disabled={creatingSession} onClick={newSession}>
            <SquarePen />
          </IconButton>
        </div>
      )}
    </header>
  );
  return (
    <AppShell
      navigation={sidebar}
      dialogs={
        <>
          {overlays.dialogs}
          {showModels && modelsQuery.isSuccess && !modelsQuery.isFetching && models && (
            <ProvidersDialog
              providers={models}
              onClose={() => setModelsOpen(false)}
              onSaved={() => {
                void client.invalidateQueries({ queryKey: rpc.providers.list.key() });
                void client.invalidateQueries({ queryKey: rpc.providers.models.key() });
                setModelsOpen(false);
                void navigation.refreshSessions();
              }}
            />
          )}
        </>
      }
      drawer={drawer}
      onDrawerChange={setDrawer}
      header={header}
    >
      {error && <InlineNotice className="mx-5 mt-3">{error}</InlineNotice>}
      {modelSetupNeeded && !showModels && (
        <div className="mx-5 mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={openModelSettings}>
            {MODEL_COPY.connect}
          </Button>
        </div>
      )}
      {match({ loaded: agentsLoaded, agent, sessionId: selection.sessionId || undefined })
        .with({ loaded: false }, () => (
          <div className="mx-auto w-full max-w-3xl space-y-4 px-6 pt-16">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-64" />
          </div>
        ))
        .with({ agent: P.nullish }, () => (
          <div className="flex flex-1 items-center justify-center px-6">
            <Button onClick={overlays.newAgent}>
              <Plus />
              {COPY.newAgent}
            </Button>
          </div>
        ))
        .with({ agent: P.nonNullable, sessionId: P.string }, ({ agent, sessionId }) => (
          <Chat
            key={`${agent.id}/${sessionId}`}
            agent={agent}
            sessionId={sessionId}
            modelEditable={selectedSession?.modelEditable !== false}
            modelSetupNeeded={modelSetupNeeded}
            onExpired={auth.expired}
            onChanged={navigation.refreshSessions}
          />
        ))
        .otherwise(() => (
          <p role="status" className="px-5 pt-10 text-center text-sm text-muted-foreground">
            {sessionsLoaded ? emptySessionsLabel : COPY.loading}
          </p>
        ))}
    </AppShell>
  );
}
