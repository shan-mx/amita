import { useRef, type ReactNode, type SyntheticEvent } from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { OverlayReturnFocusContext } from "@/components/patterns/form-dialog";

export function AppShell({
  navigation,
  dialogs,
  drawer,
  onDrawerChange,
  header,
  children,
}: {
  navigation: ReactNode;
  dialogs: ReactNode;
  drawer: boolean;
  onDrawerChange: (open: boolean) => void;
  header: ReactNode;
  children: ReactNode;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const rememberControl = (event: SyntheticEvent<HTMLDivElement>) => {
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("button, input, textarea, select, a[href], [tabindex]")
        : null;
    if (target && event.currentTarget.contains(target)) returnFocus.current = target;
  };
  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border/70 bg-sidebar md:flex">
        {navigation}
      </aside>
      <Sheet open={drawer} onOpenChange={onDrawerChange}>
        <main className="flex min-w-0 flex-1 flex-col">
          {header}
          {children}
        </main>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="w-[min(82vw,290px)] gap-0 bg-sidebar p-0 md:hidden"
          onFocusCapture={rememberControl}
          onPointerDownCapture={rememberControl}
        >
          <SheetTitle className="sr-only">Agents and sessions</SheetTitle>
          {navigation}
          <OverlayReturnFocusContext.Provider value={returnFocus}>
            {dialogs}
          </OverlayReturnFocusContext.Provider>
        </SheetContent>
      </Sheet>
      {!drawer && dialogs}
    </div>
  );
}
