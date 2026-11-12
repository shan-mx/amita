import type { Context } from "@earendil-works/chord";
import { defineTool } from "@earendil-works/pi-durable";
import { arr, bool, obj, oneOf, str } from "@earendil-works/pi-schema";
import { CONFIG } from "../shared/config";
import type { SearchHit } from "../shared/types";

const messageFields = { role: oneOf(["user", "assistant"]), text: str() };
const searchResultSchema = arr(
  obj({
    ...messageFields,
    sessionId: str(),
    title: str(),
    archived: bool(),
    context: arr(obj(messageFields)),
  }),
);

export function createSessionSearchTool(
  search: (query: string, context: Context) => Promise<SearchHit[]>,
) {
  return defineTool({
    name: "session_search",
    description: "Search this Agent's past messages, including archived Sessions.",
    replay: "safe",
    parameters: obj(
      {
        query: str({
          minLength: 1,
          maxLength: CONFIG.searchQueryMaxLength,
          description: "Literal words or phrases to search for.",
        }),
      },
      { open: true },
    ),
    structuredOutputSchema: searchResultSchema,
    async execute({ query }, _api, context) {
      const hits = (await search(query, context)).map(
        ({ sessionId, title, archived, role, text, context }) => ({
          sessionId,
          title,
          archived,
          role,
          text,
          context: context.map(({ role, text }) => ({ role, text })),
        }),
      );
      return { output: [{ type: "text", text: JSON.stringify(hits) }], structuredOutput: hits };
    },
  });
}
