import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

export function IconButton({
  "aria-label": label,
  ...props
}: ComponentProps<typeof Button> & { "aria-label": string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant="ghost" size="icon" aria-label={label} {...props} />}
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
