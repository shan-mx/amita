import { CONFIG } from "./config";

export const COMPUTER_SLUG_PATTERN = "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$";
const slugPattern = new RegExp(COMPUTER_SLUG_PATTERN);
export function validComputerSlug(value: string) {
  return value.length <= CONFIG.computerSlugMaxLength && slugPattern.test(value);
}
export function suggestSlug(name: string, reserved: ReadonlySet<string>, fallback: string) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || fallback;
  for (let suffix = 1; ; suffix++) {
    const tail = suffix === 1 ? "" : `-${suffix}`;
    const slug =
      base.slice(0, CONFIG.computerSlugMaxLength - tail.length).replace(/-+$/, "") + tail;
    if (!reserved.has(slug)) return slug;
  }
}
