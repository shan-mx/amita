import { isModelInvocable, parseSkill } from "agents/skills";

export type SkillMetadata = {
  name: string;
  description: string;
  location: string;
};

export function readSkillMetadata(content: string, location: string): SkillMetadata | undefined {
  const parsed = parseSkill(content);
  if (!parsed.ok || !isModelInvocable(parsed.value)) return;
  const { name, description } = parsed.value;
  return { name, description, location };
}

function escapeXml(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function formatSkillIndex(skills: readonly SkillMetadata[]) {
  if (!skills.length) return "";
  return [
    "Use fs_read to load a skill when the task matches its description. Resolve relative paths from the skill's directory.",
    "",
    "<available_skills>",
    ...skills.map(
      ({ name, description, location }) =>
        `  <skill>\n    <name>${escapeXml(name)}</name>\n    <description>${escapeXml(description)}</description>\n    <location>${escapeXml(location)}</location>\n  </skill>`,
    ),
    "</available_skills>",
  ].join("\n");
}
