import type { EntryRecord } from "@earendil-works/pi-durable";

export function assistantText(entry: EntryRecord | undefined) {
  return (
    entry?.model
      ?.flatMap((message) =>
        message.role === "assistant"
          ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
          : [],
      )
      .join("\n") ?? ""
  );
}
