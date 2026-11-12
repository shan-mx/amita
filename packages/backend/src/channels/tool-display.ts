import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import { BASH_TOOL_NAME } from "../computer/remote-env";
import { FS_READ_TOOL_NAME } from "../filesystem/filesystem-tools";

const layouts = new Map([
  [CODEMODE_TOOL_NAME, { icon: "🧩", field: "code", language: "javascript" }],
  [BASH_TOOL_NAME, { icon: "💻", field: "command", language: "bash" }],
]);

function backtickFence(value: string, length: number) {
  for (const match of value.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  return "`".repeat(length);
}

function codeBlock(value: string, language: string) {
  const fence = backtickFence(value, 3);
  return `${fence}${language}\n${value}\n${fence}`;
}

function fileReadLabel(path: string, offset: unknown, limit: unknown) {
  const start = typeof offset === "number" ? Math.max(1, Math.trunc(offset)) : 1;
  let range = "";
  if (typeof limit === "number" && limit >= 1) {
    const end = start + Math.trunc(limit) - 1;
    range = end === start ? ` (L${start})` : ` (L${start}-L${end})`;
  } else if (limit === undefined && typeof offset === "number") {
    range = ` (L${start}+)`;
  }
  const value = path.replace(/\r\n?|\n/g, "\\n") + range;
  const fence = backtickFence(value, 1);
  return `${fence} ${value} ${fence}`;
}

export function formatToolCall(name: string, args: Record<string, unknown>) {
  if (name === FS_READ_TOOL_NAME) {
    const heading = `📖 ${name}`;
    const { path, offset, limit } = args;
    return typeof path === "string" && path.trim()
      ? `${heading}  \n${fileReadLabel(path, offset, limit)}`
      : heading;
  }

  const layout = layouts.get(name);
  const heading = `${layout?.icon ?? "🔧"} ${name}`;
  if (layout) {
    const { [layout.field]: value, ...rest } = args;
    if (typeof value === "string" && value.trim()) {
      const blocks = [heading, codeBlock(value, layout.language)];
      if (Object.keys(rest).length) blocks.push(codeBlock(JSON.stringify(rest, null, 2), "json"));
      return blocks.join("\n\n");
    }
  }
  return `${heading}\n\n${codeBlock(JSON.stringify(args, null, 2), "json")}`;
}
