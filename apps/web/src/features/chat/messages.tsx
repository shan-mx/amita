import {
  ActionBarPrimitive,
  MessagePrimitive,
  useAuiState,
  type ReasoningMessagePartProps,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { ChevronDown, Copy } from "lucide-react";
import { IconButton } from "@/components/patterns/icon-button";
import { cn } from "@/lib/utils";
import { ToolFallback } from "./tool-card";

function Reasoning({ text }: ReasoningMessagePartProps) {
  return (
    <details className="reasoning mb-4 text-sm text-muted-foreground">
      <summary className="mb-2 flex cursor-pointer list-none items-center gap-2 select-none">
        <ChevronDown className="size-4 shrink-0 transition-transform" />
        Thinking
      </summary>
      <div className="whitespace-pre-wrap border-l-2 border-border pl-4 text-[13px] leading-relaxed">
        {text}
      </div>
    </details>
  );
}
function Text() {
  return <MarkdownTextPrimitive className="markdown" smooth={false} />;
}
export function UserMessage() {
  return (
    <MessagePrimitive.Root
      role="group"
      aria-label="User message"
      className="group flex justify-end py-3"
    >
      <div className="user-message min-w-0 max-w-[88%] [overflow-wrap:anywhere] rounded-2xl rounded-br-md bg-muted px-4 py-3 text-base leading-7">
        <MessagePrimitive.Content />
      </div>
    </MessagePrimitive.Root>
  );
}
export function AssistantMessage() {
  const first = useAuiState(
    (s) => s.message.index === 0 || s.thread.messages[s.message.index - 1]?.role !== "assistant",
  );
  const last = useAuiState((s) => s.thread.messages[s.message.index + 1]?.role !== "assistant");
  const canCopy = useAuiState(
    (s) =>
      s.message.status?.type !== "running" &&
      s.message.parts.some((part) => part.type === "text" && part.text.trim().length > 0),
  );
  return (
    <MessagePrimitive.Root
      role="group"
      aria-label="Assistant message"
      className={cn("group", first ? "pt-5" : "pt-1", last && "pb-5")}
    >
      <div className="text-base leading-7">
        <MessagePrimitive.Content
          components={{ Text, Reasoning, tools: { Fallback: ToolFallback } }}
        />
      </div>
      {last && canCopy && (
        <ActionBarPrimitive.Root className="mt-2 flex h-10 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100">
          <ActionBarPrimitive.Copy asChild>
            <IconButton aria-label="Copy">
              <Copy className="size-3.5" />
            </IconButton>
          </ActionBarPrimitive.Copy>
        </ActionBarPrimitive.Root>
      )}
    </MessagePrimitive.Root>
  );
}
