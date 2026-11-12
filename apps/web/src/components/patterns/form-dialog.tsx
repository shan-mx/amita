import {
  createContext,
  useContext,
  type ReactNode,
  type RefObject,
  type FormEventHandler,
} from "react";
import { X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const OverlayReturnFocusContext = createContext<RefObject<HTMLElement | null> | null>(null);
const widths = { sm: "sm:max-w-md", default: "sm:max-w-xl", wide: "sm:max-w-3xl" } as const;

export function FormDialog({
  open,
  onOpenChange,
  title,
  children,
  footer,
  className,
  size = "default",
  onSubmit,
  closeLabel = "Cancel",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  size?: keyof typeof widths;
  onSubmit?: FormEventHandler<HTMLFormElement>;
  closeLabel?: string;
}) {
  const returnFocus = useContext(OverlayReturnFocusContext);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        render={onSubmit ? <form onSubmit={onSubmit} /> : undefined}
        finalFocus={() => {
          const target = returnFocus?.current;
          return target?.isConnected && target.getClientRects().length > 0 ? target : true;
        }}
        className={cn(
          "flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-2xl p-0 shadow-xl",
          widths[size],
          className,
        )}
      >
        <DialogHeader className="shrink-0 px-6 pb-5 pt-6 pr-16">
          <DialogTitle className="text-lg leading-6 font-semibold">{title}</DialogTitle>
        </DialogHeader>
        <DialogClose
          render={
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-3 top-3"
              aria-label={closeLabel}
            />
          }
        >
          <X />
        </DialogClose>
        <div data-slot="form-dialog-body" className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {children}
        </div>
        {footer && (
          <div
            data-slot="form-dialog-footer"
            className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border bg-muted/30 px-6 py-4"
          >
            {footer}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
