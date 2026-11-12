import { defineDoc } from "@earendil-works/pi-durable";
type SessionMetadataState = {
  title: string;
  titleTaskId: number | null;
  archived: boolean;
  hidden: boolean;
  timezone: string | null;
  automationRunId: string | null;
};
export const SessionMetadata = defineDoc<SessionMetadataState>({
  kind: "amita.session",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    title: "",
    titleTaskId: null,
    archived: false,
    hidden: false,
    timezone: null,
    automationRunId: null,
  }),
  checkpointWhen: () => true,
});
