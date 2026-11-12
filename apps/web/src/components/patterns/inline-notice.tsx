import type { ComponentProps } from "react";
import { Alert } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

export function InlineNotice({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <Alert
      variant="destructive"
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm leading-relaxed text-destructive",
        className,
      )}
      {...props}
    >
      {children}
    </Alert>
  );
}
