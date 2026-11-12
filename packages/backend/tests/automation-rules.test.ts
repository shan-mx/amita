import { expect, it } from "vite-plus/test";
import {
  normalizeAutomation,
  nextOccurrence,
  dueOccurrence,
} from "../src/automations/automation-rules";

const calendar = (expression = "30 9 * * *", timezone = "America/New_York") =>
  normalizeAutomation({
    name: "Calendar fixture",
    trigger: { type: "cron", expression },
    timezone,
    script: "return 42;",
  });

it("resolves a local once time in its fixed IANA zone and exhausts it after admission", () => {
  const definition = normalizeAutomation({
    name: "Taipei morning",
    trigger: { type: "once", runAt: "2026-11-10T09:00" },
    timezone: "Asia/Taipei",
    prompt: "Good morning.",
  });
  const at = Date.parse("2026-11-10T01:00:00Z");
  expect(definition.trigger).toEqual({ type: "once", at });
  expect(dueOccurrence(definition, at - 1000, at)).toEqual({ due: at, next: null });
  expect(nextOccurrence(definition, at)).toBeNull();
  const edited = normalizeAutomation({ name: "Renamed" }, "Europe/London", definition);
  expect(edited.timezone).toBe("Asia/Taipei");
  expect(edited.trigger).toEqual(definition.trigger);
});

it("keeps local cron wall time through spring and autumn DST changes", () => {
  const definition = calendar();
  expect(nextOccurrence(definition, Date.parse("2026-03-07T14:30:00Z"))).toBe(
    Date.parse("2026-03-08T13:30:00Z"),
  );
  expect(nextOccurrence(definition, Date.parse("2026-10-31T13:30:00Z"))).toBe(
    Date.parse("2026-11-01T14:30:00Z"),
  );
});

it("coalesces missed minutes to the latest due opportunity without a duplicate on the boundary", () => {
  const definition = calendar("* * * * *", "Asia/Taipei");
  const cursor = Date.parse("2026-11-08T00:00:00Z");
  const now = Date.parse("2026-11-08T00:07:30Z");
  expect(dueOccurrence(definition, cursor, now)).toEqual({
    due: Date.parse("2026-11-08T00:07:00Z"),
    next: Date.parse("2026-11-08T00:08:00Z"),
  });
  expect(dueOccurrence(definition, now - 30000, now - 30000)).toEqual({
    due: null,
    next: Date.parse("2026-11-08T00:08:00Z"),
  });
});

it("requires an explicit or browser time zone and rejects sub-minute cron rules", () => {
  expect(() =>
    normalizeAutomation({
      name: "Missing zone",
      trigger: { type: "cron", expression: "* * * * *" },
      script: "return 1;",
    }),
  ).toThrow(/time zone/);
  for (const expression of ["* * * * * *", "61 * * * *", "@hourly"])
    expect(() => calendar(expression)).toThrow(/five-field/);
  expect(() => calendar("* * * * *", "Mars/Olympus")).toThrow(/time zone/);
});
