import { match, P } from "ts-pattern";
import { Button } from "@/components/ui/button";
import { FormDialog } from "@/components/patterns/form-dialog";
import { InlineNotice } from "@/components/patterns/inline-notice";
import { cn } from "@/lib/utils";
import { COPY } from "@/lib/copy";
import { AUTOMATION_COPY as C } from "@/features/automations/copy";

import { newForm, editForm } from "./form-state";
import { displayTime, automationStatusLabel } from "./format";
import { useAutomations } from "./use-automations";
import { AutomationForm } from "./form";
import { RunCard } from "./history";
export function AutomationsDialog({
  agentId,
  onClose,
  onSelectSession,
}: {
  agentId: string;
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
}) {
  const {
    items,
    options,
    selectedId,
    setSelectedId,
    editing,
    setEditing,
    error,
    busy,
    loading,
    now,
    current,
    selectedRuns,
    cursor,
    activeRunEnded,
    toggle,
    remove,
    stop,
    loadingMore,
    loadMore,
  } = useAutomations(agentId);
  const hasActiveRun = Boolean(current?.activeRun) && !activeRunEnded;
  return (
    <FormDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={C.title}
      size="wide"
    >
      <div className="grid min-w-0 gap-5 sm:grid-cols-[minmax(190px,0.75fr)_minmax(0,1.25fr)]">
        <section aria-label={C.title} className="min-w-0">
          <div className="mb-3">
            <Button
              size="sm"
              onClick={() => {
                setEditing(newForm());
              }}
            >
              {C.create}
            </Button>
          </div>
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{loading ? COPY.loading : C.empty}</p>
          ) : (
            <div className="space-y-1">
              {items.map((item) => {
                const d = item.definition;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={selectedId === item.id ? "true" : undefined}
                    onClick={() => {
                      setSelectedId(item.id);
                      setEditing(undefined);
                    }}
                    className={cn(
                      "w-full rounded-lg px-3 py-2 text-left",
                      selectedId === item.id ? "bg-accent" : "hover:bg-muted",
                    )}
                  >
                    <span className="block truncate text-sm font-medium">{d.name}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {automationStatusLabel(item, now)}
                    </span>
                    {item.nextRun != null && (
                      <span className="mt-1 block truncate text-xs text-muted-foreground">
                        {C.nextRun}: {displayTime(item.nextRun, d.timezone)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </section>
        <section className="min-w-0 border-border sm:border-s sm:ps-5">
          {match({ editing, current })
            .with({ editing: P.nonNullable }, ({ editing }) => (
              <AutomationForm
                key={editing.id}
                initial={editing}
                agentId={agentId}
                options={options}
                onCancel={() => setEditing(undefined)}
                onSaved={(saved) => {
                  setSelectedId(saved.id);
                  setEditing(undefined);
                }}
              />
            ))
            .with({ current: P.nonNullable }, ({ current }) => (
              <>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-medium">{current.definition.name}</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {automationStatusLabel(current, now)}
                      {current.nextRun != null
                        ? ` · ${C.nextRun}: ${displayTime(current.nextRun, current.definition.timezone)}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 sm:shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditing(editForm(current));
                      }}
                    >
                      {C.edit}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={remove} disabled={Boolean(busy)}>
                      {C.remove}
                    </Button>
                  </div>
                </div>
                {hasActiveRun && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Deleting stops future runs and keeps any active run going.
                  </p>
                )}
                <div className="my-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={toggle}>
                    {current.definition.enabled ? C.pause : C.resume}
                  </Button>
                  {hasActiveRun && (
                    <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={stop}>
                      {C.stop}
                    </Button>
                  )}
                </div>
                <h3 className="mb-2 text-sm font-medium">{C.history}</h3>
                <div className="max-h-[42dvh] space-y-2 overflow-y-auto pr-1">
                  {selectedRuns.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{C.noRuns}</p>
                  ) : (
                    selectedRuns.map((run) => (
                      <RunCard
                        key={run.id}
                        run={run}
                        timezone={current.definition.timezone}
                        onStop={stop}
                        onOpen={
                          run.sessionId
                            ? () => {
                                onSelectSession(run.sessionId!);
                                onClose();
                              }
                            : undefined
                        }
                        busy={Boolean(busy)}
                      />
                    ))
                  )}
                  {cursor && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void loadMore()}
                      disabled={loadingMore}
                    >
                      Load older runs
                    </Button>
                  )}
                </div>
              </>
            ))
            .otherwise(() => null)}
        </section>
      </div>
      {error && <InlineNotice className="mt-4">{error}</InlineNotice>}
    </FormDialog>
  );
}
