import { describe, expect, it } from "vitest";
import { shortDate, dateTime, monthLabel } from "../../src/lib/dates";

describe("named month date displays", () => {
  it("preserves calendar dates without browser timezone conversion", () => {
    expect(shortDate("2026-10-05")).toBe("5 Oct 2026");
    expect(shortDate("2026-10-05T00:00:00.000Z")).toBe("5 Oct 2026");
    expect(shortDate(null)).toBe("Date not provided");
  });
  it("uses named months and 24-hour Tallinn time across midnight and seasons", () => {
    expect(dateTime("2026-01-31T22:15:00Z")).toBe("1 Feb 2026 00:15");
    expect(dateTime("2026-07-31T21:15:00Z")).toBe("1 Aug 2026 00:15");
    expect(dateTime("2026-10-05T13:05:00Z")).toBe("5 Oct 2026 16:05");
    expect(dateTime(null)).toBe("Not yet");
    expect(dateTime(undefined)).toBe("Not yet");
  });
  it("formats reporting months with a year, including compact chart labels", () => {
    expect(monthLabel("2026-10")).toBe("October 2026");
    expect(monthLabel("2027-01")).toBe("January 2027");
    expect(monthLabel("2026-10", true)).toBe("Oct 26");
  });
});
