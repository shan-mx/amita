import { arr, bool, int, lit, nullable, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { defineTool } from "@earendil-works/pi-durable";
import type { Channels } from "./service";
import { ChannelError } from "./adapter";

export function listChannelTool(channels: Channels) {
  return defineTool({
    name: "channel_list",
    description: "List and search this Agent's known Channel destinations.",
    replay: "safe",
    parameters: obj({
      query: opt(
        str({ maxLength: 256, description: "Search by connection, chat, or thread name." }),
      ),
      offset: opt(int({ minimum: 0, default: 0, description: "Result offset for pagination." })),
    }),
    structuredOutputSchema: obj({
      destinations: arr(
        obj({
          id: str(),
          platform: str(),
          label: str(),
          canSend: bool(),
        }),
      ),
      nextOffset: nullable(int()),
    }),
    execute: async ({ query, offset = 0 }, _api, context) => {
      const value = await channels.listDestinations(query, offset, context);
      return { output: [{ type: "text", text: JSON.stringify(value) }], structuredOutput: value };
    },
  });
}

export function sendChannelTool(channels: Channels) {
  return defineTool({
    name: "channel_send",
    description:
      "Send text, Computer files, or both to a Channel destination and return the delivery outcome.",
    replay: "safe",
    parameters: obj({
      text: opt(str({ minLength: 1 })),
      files: opt(
        arr(
          obj({
            path: str({ minLength: 1, description: "Complete virtual path of the file to send." }),
          }),
          { minItems: 1 },
        ),
      ),
      destinationId: opt(
        str({
          minLength: 1,
          description: "Identifier of a known Channel destination. Mutually exclusive with target.",
        }),
      ),
      target: opt(
        lit("current", {
          description: "The current Channel chat or thread. Mutually exclusive with destinationId.",
        }),
      ),
    }),
    structuredOutputSchema: obj({
      destination: obj({ id: str(), label: str() }),
      status: oneOf(["sent", "cancelled", "failed", "unknown"]),
      receipts: arr(str()),
      files: opt(arr(obj({ name: str(), receipt: str() }))),
      error: opt(str()),
    }),
    execute: async ({ text, files, destinationId, target }, api, context) => {
      try {
        const value = await channels.send(text, files, { destinationId, target }, api, context);
        return {
          output: [{ type: "text", text: JSON.stringify(value) }],
          structuredOutput: value,
          isError: value.status !== "sent",
        };
      } catch (error) {
        context.abortSignal?.throwIfAborted();
        if (!(error instanceof ChannelError)) throw error;
        return { output: [{ type: "text", text: error.message }], isError: true };
      }
    },
  });
}
