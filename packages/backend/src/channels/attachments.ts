import { defineDocFamily, type ConversationId } from "@earendil-works/pi-durable";
import type { ChannelAttachment } from "./adapter";

export type AttachmentMetadata = Omit<ChannelAttachment, "locator"> & { id: string };

export const AttachmentRef = defineDocFamily<
  {
    value:
      | (AttachmentMetadata & {
          locator: string;
          destinationId: string;
          connectionId: string;
          conversationId: ConversationId;
        })
      | null;
  },
  null
>({
  kind: "amita.channels.attachment",
  scope: "session",
  family: true,
  version: 1,
  initial: () => ({ value: null }),
  checkpointWhen: () => true,
});

export function attachmentInput({ id, name, mediaType, size }: AttachmentMetadata) {
  return `Attachment: ${name} (${mediaType}${size === undefined ? "" : `, ${size} bytes`}, attachmentId ${id})`;
}
