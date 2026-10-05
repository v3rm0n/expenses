import { describe, expect, it } from "vitest";
import { shortDate, dateTime } from "../../src/lib/dates";

describe("ISO date displays", () => {
  it("preserves calendar dates without browser timezone conversion", () => {
    expect(shortDate("2026-10-05")).toBe("2026-10-05");
    expect(shortDate("2026-10-05T00:00:00.000Z")).toBe("2026-10-05");
    expect(shortDate(null)).toBe("Date not provided");
  });
  it("uses ISO dates and 24-hour Tallinn time across midnight and seasons", () => {
    expect(dateTime("2026-01-31T22:15:00Z")).toBe("2026-02-01 00:15");
    expect(dateTime("2026-07-31T21:15:00Z")).toBe("2026-08-01 00:15");
    expect(dateTime("2026-10-05T13:05:00Z")).toBe("2026-10-05 16:05");
    expect(dateTime(null)).toBe("Not yet");
    expect(dateTime(undefined)).toBe("Not yet");
  });
});
