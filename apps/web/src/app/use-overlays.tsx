import { useState } from "react";
import type { SessionInfo } from "@amita/backend/types";
import { AgentForm } from "@/features/agents/agent-form";
import { MemoryDialog } from "@/features/memory/memory-dialog";
import { SessionSearch } from "@/features/sessions/session-search";
import { SessionDialog } from "@/features/sessions/session-dialog";
import { ComputerDialog } from "@/features/computers/computer-dialog";
import { AutomationsDialog } from "@/features/automations/dialog";
import { ChannelsDialog } from "@/features/channels/dialog";
import type { useNavigation } from "./use-navigation";

/** Owns overlay lifetimes; navigation owns the records they edit. */
export function useOverlays(navigation: ReturnType<typeof useNavigation>, onNavigate: () => void) {
  const { agent, sessions, selection, archived, refreshSessions, selectSession } = navigation;
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [sessionTarget, setSessionTarget] = useState<SessionInfo>();
  const [computerOpen, setComputerOpen] = useState(false);
  const [automationsOpen, setAutomationsOpen] = useState(false);
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [form, setForm] = useState<"new" | "settings">();
  const dialogs = (
    <>
      {agent && (
        <>
          {memoryOpen && (
            <MemoryDialog key={agent.id} agentId={agent.id} onClose={() => setMemoryOpen(false)} />
          )}
          {searchOpen && (
            <SessionSearch
              key={agent.id}
              agentId={agent.id}
              onClose={() => setSearchOpen(false)}
              onSelect={(sessionId, isArchived) => {
                selectSession(sessionId, isArchived);
                setSearchOpen(false);
                onNavigate();
              }}
            />
          )}
          {sessionOpen && (
            <SessionDialog
              key={`${agent.id}/${sessionTarget?.id ?? selection.sessionId}`}
              agentId={agent.id}
              session={sessionTarget ?? sessions.find((item) => item.id === selection.sessionId)}
              onClose={() => {
                setSessionOpen(false);
                setSessionTarget(undefined);
              }}
              onChanged={(nextArchived) => navigation.sessionUpdated(nextArchived, sessionTarget)}
            />
          )}
          {automationsOpen && (
            <AutomationsDialog
              key={agent.id}
              agentId={agent.id}
              onClose={() => setAutomationsOpen(false)}
              onSelectSession={(sessionId) => {
                selectSession(sessionId, false);
                setAutomationsOpen(false);
                onNavigate();
                if (!archived) void refreshSessions();
              }}
            />
          )}
          {channelsOpen && (
            <ChannelsDialog
              key={agent.id}
              agentId={agent.id}
              onClose={() => setChannelsOpen(false)}
            />
          )}
        </>
      )}
      {computerOpen && <ComputerDialog onClose={() => setComputerOpen(false)} />}
      {form && (
        <AgentForm
          key={`${form}/${agent?.id}`}
          agent={form === "settings" ? agent : undefined}
          onClose={() => setForm(undefined)}
          onSaved={(next, sessionId) => {
            navigation.agentSaved(next, sessionId);
            if (next) onNavigate();
          }}
        />
      )}
    </>
  );
  return {
    dialogs,
    memory: () => setMemoryOpen(true),
    search: () => setSearchOpen(true),
    computer: () => setComputerOpen(true),
    automations: () => setAutomationsOpen(true),
    channels: () => setChannelsOpen(true),
    newAgent: () => setForm("new"),
    agentSettings: () => setForm("settings"),
    session: (target?: SessionInfo) => {
      setSessionTarget(target);
      setSessionOpen(true);
    },
  };
}
