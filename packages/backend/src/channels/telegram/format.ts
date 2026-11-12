import { TelegramAdapter } from "@chat-adapter/telegram";
import type { Content, Root } from "chat";
import { ChannelError } from "../adapter";

const TELEGRAM_TEXT_LIMIT = 4096;

const root = (children: Content[]): Root => ({ type: "root", children });

/** Isolate the protected SDK planner until a public pure splitting API is available. */
export class TelegramTextAdapter extends TelegramAdapter {
  prepareText(text: string, kind?: "tool"): string[] {
    const ast = this.formatConverter.toAst(text);
    if (ast.children.length === 0) return [];
    const parts = this.splitLongMessage({ ast }, false) ?? [{ ast }];
    return parts.map((part) => {
      if (typeof part === "string" || !("ast" in part))
        throw new Error("The Telegram SDK returned a non-AST split part.");
      const rendered =
        kind === "tool"
          ? part.ast.children.map((node) => this.formatConverter.fromAst(root([node]))).join("\n")
          : this.formatConverter.fromAst(part.ast);
      if (rendered.length > TELEGRAM_TEXT_LIMIT)
        throw new ChannelError("This message contains formatting that exceeds Telegram's limit.");
      return rendered;
    });
  }
}
