import { unknown, type Schema } from "@earendil-works/pi-schema";
import { defineTool } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { z } from "zod";
import { Automations } from "./automations";
import {
  automationWriteSchema,
  automationPatchSchema,
  automationSessionIdSchema,
  existingSessionExecutionSchema,
  newSessionExecutionSchema,
  automationReply,
} from "./automation-rules";
import { toolError } from "../shared/tool-error";
import { SessionMetadata } from "../agent/session-metadata";

const id = z.string().uuid();
const target = z.object({ id });
const createJob = z.object({ job: automationWriteSchema });
const updateJob = z.object({ job: automationPatchSchema });
const actions = ["list", "get", "create", "update", "remove", "stop", "history"] as const;
const jobSchema = automationPatchSchema.extend({
  execution: z
    .discriminatedUnion("kind", [
      newSessionExecutionSchema,
      existingSessionExecutionSchema.extend({
        sessionId: z
          .union([automationSessionIdSchema, z.literal("current")])
          .describe("Session ID to continue. Use 'current' for the calling Session."),
      }),
    ])
    .nullable()
    .optional()
    .describe(
      "Agent execution target. On create, a message defaults to new_session. On update, omit to keep the saved target, provide a complete target to replace it, or set null to clear it. Omit for script-only tasks.",
    ),
});
const requiredJob = z.object({ job: jobSchema });
const parameters = z.object({
  action: z.enum(actions),
  id: id.optional().describe("Automation ID. Required for get, update, remove, stop, and history."),
  job: jobSchema
    .optional()
    .describe(
      "Required for create and update. A new automation needs a script, a prompt, or both. Set enabled to pause or resume.",
    ),
  cursor: z.string().max(2048).optional().describe("Pagination cursor for history."),
});

export function automationTools(automations: Automations) {
  return [
    defineTool({
      name: "automation",
      description:
        "Manage this Agent's automations. list returns summaries; get returns the full definition. For external delivery, use channel_list to resolve the destination and save its ID and sending instructions in the job's message or script. stop cancels active work and leaves future triggers enabled. Running executions keep their original definition.",
      replay: "unsafe",
      parameters: z.toJSONSchema(parameters, { target: "draft-7" }) as Schema<
        z.infer<typeof parameters>
      >,
      structuredOutputSchema: unknown(),
      execute: async (input, api, context) => {
        const reply = await automationReply(async () => {
          const args = parameters.parse(input);
          const job = () => {
            const { job: fields } = requiredJob.parse(args);
            const { execution } = fields;
            if (execution?.kind === "existing_session" && execution.sessionId === "current") {
              execution.sessionId = String(api.conversationId);
            }
            return fields;
          };
          if (args.action === "list")
            return (await automations.list()).map(({ definition, ...summary }) => ({
              ...summary,
              name: definition.name,
              trigger: definition.trigger,
              timezone: definition.timezone,
              enabled: definition.enabled,
            }));
          if (args.action === "create") {
            const fields = job();
            const saved = await automations.create(
              await api.memo("amita.automation.id", crypto.randomUUID(), context),
              createJob.parse({ job: fields }).job,
              (await api.snapshot(SessionMetadata, api.conversationId, context))?.timezone ??
                undefined,
            );
            return saved;
          }
          const { id: targetId } = target.parse(args);
          switch (args.action) {
            case "get":
              return automations.info(targetId);
            case "update": {
              const fields = job();
              const saved = await automations.update(
                targetId,
                updateJob.parse({ job: fields }).job,
              );
              return saved;
            }
            case "remove":
              return automations.remove(targetId);
            case "stop":
              return automations.stop(targetId);
            case "history":
              return automations.history(targetId, args.cursor);
          }
        });
        if (!reply.ok) return toolError(reply.error);
        const value = JSON.parse(JSON.stringify(reply.value)) as JsonValue;
        return { output: [{ type: "text", text: JSON.stringify(value) }], structuredOutput: value };
      },
    }),
  ];
}
