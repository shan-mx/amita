import type { Context } from "@earendil-works/chord";
import type { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { Conversation, Cursor, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { CONFIG } from "../shared/config";
import type { SearchHit, SearchMessage, SessionInfo } from "../shared/types";

export function entryMessages(entry: EntryRecord): SearchMessage[] {
  return (entry.model ?? []).flatMap((message): SearchMessage[] => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
    return text ? [{ entryId: Number(entry.id), role: message.role, text }] : [];
  });
}

function excerpt(text: string, query: string[], limit: number): string {
  const lower = text.toLocaleLowerCase();
  const matches = query
    .map((term) => lower.indexOf(term.toLocaleLowerCase()))
    .filter((index) => index >= 0);
  const start = Math.max(0, (matches.length ? Math.min(...matches) : 0) - Math.floor(limit / 4));
  return `${start ? "…" : ""}${text.slice(start, start + limit)}${text.length > start + limit ? "…" : ""}`;
}

/** A rebuildable read projection. Its maintenance lock never starts Agent work. */
export class HistoryIndex {
  private ready?: Promise<void>;
  private maintenance: Promise<unknown> = Promise.resolve();
  constructor(private readonly db: DurableObjectSqliteDatabase) {}
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.maintenance.then(action);
    this.maintenance = result.catch(() => {});
    return result;
  }
  private initialize() {
    return (this.ready ??= (async () => {
      await this.db.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS amita_history_fts USING fts5(conversation_id UNINDEXED, body, tokenize='trigram'); CREATE TABLE IF NOT EXISTS amita_history_checkpoint (conversation_id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL)",
      );
    })().catch((error) => {
      this.ready = undefined;
      throw error;
    }));
  }
  private async catchUp(
    sessions: readonly SessionInfo[],
    conversation: (id: string) => Promise<Conversation>,
    context: Context,
  ) {
    for (const session of sessions) {
      context.abortSignal?.throwIfAborted();
      const handle = await conversation(session.id);
      const newest = (await handle.entries({}, 1, undefined, context)).items[0];
      if (!newest) continue;
      const mark = await this.db.get<{ entry_id: number }>(
        "SELECT entry_id FROM amita_history_checkpoint WHERE conversation_id = ?",
        Number(session.id),
      );
      let cursor: Cursor | undefined;
      do {
        context.abortSignal?.throwIfAborted();
        const page = await handle.entries(
          {
            order: "ascending",
            minEntryId: ((mark?.entry_id ?? 0) + 1) as EntryId,
            maxEntryId: newest.id,
          },
          CONFIG.historyPageSize,
          cursor,
          context,
        );
        if (page.items.length)
          await this.db.transaction(async (tx) => {
            for (const entry of page.items) {
              const body = entryMessages(entry)
                .map((message) => message.text)
                .join("\n");
              if (body)
                await tx.run(
                  "INSERT OR REPLACE INTO amita_history_fts(rowid, conversation_id, body) VALUES (?, ?, ?)",
                  Number(entry.id),
                  Number(session.id),
                  body,
                );
            }
            await tx.run(
              "INSERT INTO amita_history_checkpoint(conversation_id, entry_id) VALUES (?, ?) ON CONFLICT(conversation_id) DO UPDATE SET entry_id = excluded.entry_id",
              Number(session.id),
              Number(page.items.at(-1)!.id),
            );
          });
        cursor = page.next;
      } while (cursor);
    }
  }
  rebuild(
    sessions: readonly SessionInfo[],
    conversation: (id: string) => Promise<Conversation>,
    context: Context,
  ) {
    return this.serial(async () => {
      await this.initialize();
      await this.db.transaction(async (tx) => {
        await tx.run("DELETE FROM amita_history_fts");
        await tx.run("DELETE FROM amita_history_checkpoint");
      });
      await this.catchUp(sessions, conversation, context);
      return { rebuilt: true };
    });
  }
  search(
    query: string,
    sessions: readonly SessionInfo[],
    conversation: (id: string) => Promise<Conversation>,
    context: Context,
  ): Promise<SearchHit[]> {
    return this.serial(async () => {
      await this.initialize();
      await this.catchUp(sessions, conversation, context);
      const terms = query.trim().split(/\s+/u).filter(Boolean);
      if (!terms.length) return [];
      const long = terms.filter((term) => [...term].length >= 3);
      const short = terms.filter((term) => [...term].length < 3);
      const clauses: string[] = [];
      const params: string[] = [];
      if (short.length) {
        clauses.push(
          "NOT EXISTS (SELECT 1 FROM json_each(?) AS term WHERE instr(lower(body), lower(term.value)) = 0)",
        );
        params.push(JSON.stringify(short));
      }
      if (long.length) {
        clauses.push("amita_history_fts MATCH ?");
        params.push(long.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND "));
      }
      const rows = await this.db.all<{ rowid: number; conversation_id: number }>(
        `SELECT rowid, conversation_id FROM amita_history_fts WHERE ${clauses.join(" AND ")} ORDER BY rowid DESC LIMIT ?`,
        ...params,
        CONFIG.searchResultLimit,
      );
      const results: SearchHit[] = [];
      for (const row of rows) {
        const session = sessions.find((item) => Number(item.id) === row.conversation_id);
        if (!session) continue;
        const handle = await conversation(session.id);
        const entry = (
          await handle.entries(
            { minEntryId: row.rowid as EntryId, maxEntryId: row.rowid as EntryId },
            1,
            undefined,
            context,
          )
        ).items[0];
        if (!entry) continue;
        const message = entryMessages(entry)[0];
        if (!message) continue;
        const [before, after] = await Promise.all([
          handle.entries(
            { maxEntryId: (row.rowid - 1) as EntryId },
            CONFIG.searchContextEntries,
            undefined,
            context,
          ),
          handle.entries(
            { minEntryId: (row.rowid + 1) as EntryId, order: "ascending" },
            CONFIG.searchContextEntries,
            undefined,
            context,
          ),
        ]);
        const preceding = [...before.items].reverse().flatMap(entryMessages).slice(-2);
        const following = after.items.flatMap(entryMessages).slice(0, 2);
        results.push({
          ...message,
          text: excerpt(message.text, terms, CONFIG.searchSnippetChars),
          sessionId: session.id,
          title: session.title,
          archived: session.archived,
          context: [...preceding, ...following].map((item) => ({
            ...item,
            text: excerpt(item.text, [], CONFIG.searchContextChars),
          })),
        });
      }
      return results;
    });
  }
}
