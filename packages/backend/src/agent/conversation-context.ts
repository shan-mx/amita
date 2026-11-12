import type { Context } from "@earendil-works/chord";
import {
  CompactionEntry,
  defineDoc,
  type ConversationId,
  type EntryId,
  type Harness,
  type PromptInput,
  type PromptSection,
  type Tx,
} from "@earendil-works/pi-durable";
import { PROMPT_SECTIONS } from "../shared/config";
import { formatSkillIndex, type SkillMetadata } from "../skills/skill-index";

export type ConversationBaseline = {
  persona: string;
  memory: string;
  computers: { slug: string; name: string }[];
  skills: SkillMetadata[];
};

type SavedBaseline = ConversationBaseline & { compactionEntryId: EntryId | null };

const baselineDocument = defineDoc<SavedBaseline>({
  kind: "amita.conversation-baseline",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ persona: "", memory: "", computers: [], skills: [], compactionEntryId: null }),
  checkpointWhen: () => true,
});

export async function saveConversationBaseline(
  tx: Tx,
  id: ConversationId,
  data: ConversationBaseline,
  compactionEntryId: EntryId | null = null,
) {
  Object.assign(await tx.doc(baselineDocument, id), data, { compactionEntryId });
}

function readBaseline(input: PromptInput, context: Context) {
  return input.read.snapshot(baselineDocument, input.conversationId, context);
}

export function conversationSections(
  harness: () => Promise<Harness>,
  capture: () => Promise<ConversationBaseline>,
): PromptSection[] {
  async function refreshBaselineAfterCompaction(input: PromptInput, context: Context) {
    const previous = await readBaseline(input, context);
    if (!previous) return;
    const pi = await harness();
    const id = input.conversationId;
    const marker = await pi.commit((tx) => tx.latestHeadMarker(id), context);
    if (!marker || !CompactionEntry.is(marker) || marker.id === previous.compactionEntryId)
      return previous;

    const latest = await capture();
    const saved = await pi.commit(async (tx) => {
      if ((await tx.latestHeadMarker(id))?.id !== marker.id) return false;
      await saveConversationBaseline(tx, id, latest, marker.id);
      return true;
    }, context);
    return saved ? latest : previous;
  }

  return [
    {
      key: PROMPT_SECTIONS.persona,
      // Pi 1.5 has no post-compaction hook. The first prompt section refreshes the shared
      // baseline before the remaining sections read it.
      render: async (input, context) =>
        (await refreshBaselineAfterCompaction(input, context))?.persona,
    },
    {
      key: PROMPT_SECTIONS.memory,
      render: async (input, context) => (await readBaseline(input, context))?.memory,
    },
    {
      key: PROMPT_SECTIONS.computer,
      render: async (input, context) => {
        const computers = (await readBaseline(input, context))?.computers;
        return computers?.map(({ slug, name }) => `${slug} (${name})`).join("\n") ?? "";
      },
    },
    {
      key: PROMPT_SECTIONS.filesystem,
      render: () =>
        "Filesystem tools use complete virtual paths. Paths returned by filesystem tools, channel_download, and bash.fullOutputPath can be passed unchanged to fs_read or other filesystem tools. Paths printed by shell commands use the Computer's native filesystem.",
    },
    {
      key: PROMPT_SECTIONS.skills,
      tag: false,
      render: async (input, context) =>
        formatSkillIndex((await readBaseline(input, context))?.skills ?? []),
    },
  ];
}
