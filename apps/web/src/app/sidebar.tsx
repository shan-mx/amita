import { useId } from "react";
import {
  Archive,
  ArchiveRestore,
  BookOpen,
  Check,
  ChevronDown,
  ChevronsUpDown,
  Clock,
  Ellipsis,
  LogOut,
  MessageCircle,
  Monitor,
  Send,
  Pencil,
  Plus,
  Search,
  Settings,
  X,
} from "lucide-react";
import { AUTOMATION_COPY } from "@/features/automations/copy";
import { COPY } from "@/lib/copy";
import { MODEL_COPY } from "@/features/models/copy";
import type { AgentInfo, SessionInfo } from "@amita/backend/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type Actions = {
  selectAgent: (id: string) => void;
  newAgent: () => void;
  agentSettings: () => void;
  memory: () => void;
  newSession: () => void;
  search: () => void;
  automations: () => void;
  channels: () => void;
  toggleArchived: () => void;
  selectSession: (id: string) => void;
  renameSession: (session: SessionInfo) => void;
  archiveSession: (session: SessionInfo) => void;
  computer: () => void;
  modelSettings: () => void;
  signOut: () => void;
  close: () => void;
};

export function Sidebar({
  agents,
  agent,
  sessions,
  sessionId,
  archived,
  creatingSession,
  archivingSessionId,
  actions,
}: {
  agents: AgentInfo[];
  agent?: AgentInfo;
  sessions: SessionInfo[];
  sessionId?: string;
  archived: boolean;
  creatingSession: boolean;
  archivingSessionId?: string;
  actions: Actions;
}) {
  const runningLabelId = useId();
  return (
    <>
      <div className="mx-3 mt-2 flex min-h-12 shrink-0 items-center gap-1">
        {agent && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  className="min-w-0 flex-1 justify-between font-semibold"
                  aria-label={`Switch agent: ${agent.name}`}
                />
              }
            >
              <span className="truncate">{agent.name}</span>
              <ChevronsUpDown className="text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {agents.map((item) => (
                <DropdownMenuItem
                  key={item.id}
                  aria-current={item.id === agent.id ? "true" : undefined}
                  onClick={() => actions.selectAgent(item.id)}
                >
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  {item.id === agent.id && <Check className="shrink-0" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={actions.newAgent}>
                <Plus />
                {COPY.newAgent}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={actions.agentSettings}>
                <Settings />
                {COPY.agentSettings}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={actions.memory}>
                <BookOpen />
                {COPY.memory}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto md:hidden"
          aria-label="Close sidebar"
          onClick={actions.close}
        >
          <X />
        </Button>
      </div>
      {agent && (
        <>
          <div className="mx-3 mb-3 mt-1 space-y-0.5">
            <Button
              className="w-full justify-start"
              variant="outline"
              disabled={creatingSession}
              onClick={actions.newSession}
            >
              <Plus />
              {creatingSession ? COPY.loading : COPY.newSession}
            </Button>
            <Button className="w-full justify-start" variant="ghost" onClick={actions.search}>
              <Search />
              {COPY.searchSessions}
            </Button>
            <Button className="w-full justify-start" variant="ghost" onClick={actions.automations}>
              <Clock />
              {AUTOMATION_COPY.title}
            </Button>
            <Button className="w-full justify-start" variant="ghost" onClick={actions.channels}>
              <Send />
              Channels
            </Button>
          </div>
          <nav aria-label="Sessions" className="flex min-h-0 flex-1 flex-col px-3">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    className="w-full justify-between text-xs text-muted-foreground"
                  />
                }
              >
                {archived ? COPY.archivedSessions : COPY.activeSessions}
                <ChevronDown />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onClick={actions.toggleArchived}>
                  {archived ? <MessageCircle /> : <Archive />}
                  {archived ? "View active sessions" : "View archived sessions"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <span id={runningLabelId} hidden>
              {COPY.running}
            </span>
            <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pb-3">
              {sessions.map((item) => (
                <li
                  key={item.id}
                  className={cn(
                    "nav-session-row flex items-center rounded-lg",
                    item.id === sessionId && "bg-accent",
                  )}
                >
                  <button
                    type="button"
                    className="nav-session flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 text-left text-sm"
                    onClick={() => actions.selectSession(item.id)}
                    aria-current={item.id === sessionId ? "page" : undefined}
                    aria-describedby={item.busy ? runningLabelId : undefined}
                    title={item.title}
                  >
                    <span className="truncate">{item.title}</span>
                    {item.busy && (
                      <span
                        className="ml-auto size-1.5 shrink-0 rounded-full bg-success"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon"
                          className="nav-session-more shrink-0 text-muted-foreground"
                          aria-label={`More actions: ${item.title}`}
                        />
                      }
                    >
                      <Ellipsis />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => actions.renameSession(item)}>
                        <Pencil />
                        {COPY.rename}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={Boolean(archivingSessionId)}
                        onClick={() => actions.archiveSession(item)}
                      >
                        {item.archived ? <ArchiveRestore /> : <Archive />}
                        {item.archived ? COPY.restore : COPY.archive}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              ))}
            </ul>
          </nav>
        </>
      )}
      <div className="mx-3 mt-auto flex shrink-0 items-center gap-1 border-t border-border/70 py-2">
        <Button
          variant="ghost"
          className="min-w-0 flex-1 justify-start"
          onClick={actions.computer}
          aria-label={COPY.computer}
        >
          <Monitor className="text-muted-foreground" />
          {COPY.computer}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon" aria-label="Settings" />}
          >
            <Settings />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top">
            <DropdownMenuItem onClick={actions.modelSettings}>
              <Settings />
              {MODEL_COPY.settings}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={actions.signOut}>
              <LogOut />
              {COPY.signOut}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}
