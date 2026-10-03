import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { randomEntryId } from "../../src/lib/ids";
vi.mock("../../src/server/config", () => ({
  config: {
    appUrl: "https://expenses.example.com",
    accessUrl: "http://app.example-tailnet.ts.net:4317",
    port: 4317,
  },
}));
vi.mock("../../src/server/db", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));
import { assertOrigin } from "../../src/server/auth";
describe("configured access origins", () => {
  it.each([
    "https://expenses.example.com",
    "http://127.0.0.1:4317",
    "http://localhost:4317",
    "http://app.example-tailnet.ts.net:4317",
  ])("allows %s", (origin) => {
    expect(() =>
      assertOrigin(
        new NextRequest("http://127.0.0.1:4317/api/auth/setup", {
          headers: { Origin: origin },
        }),
      ),
    ).not.toThrow();
  });
  it.each([
    "http://another.example-tailnet.ts.net:4317",
    "http://app.example-tailnet.ts.net:4318",
    "https://wrong.example",
    "null",
    "",
  ])("rejects unconfigured origin %s", (origin) => {
    expect(() =>
      assertOrigin(
        new NextRequest("http://127.0.0.1:4317/api/auth/setup", {
          headers: origin ? { Origin: origin } : {},
        }),
      ),
    ).toThrow("origin is not allowed");
  });
});
describe("cash entry identifiers over HTTP", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("generates random v4 UUIDs when randomUUID is unavailable", () => {
    const getRandomValues = globalThis.crypto.getRandomValues.bind(
      globalThis.crypto,
    );
    vi.stubGlobal("crypto", { getRandomValues });
    const values = Array.from({ length: 100 }, () => randomEntryId());
    values.forEach((value) =>
      expect(value).toMatch(
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
      ),
    );
    expect(new Set(values).size).toBe(values.length);
  });
  it("uses native randomUUID when available", () => {
    const randomUUID = vi.fn(() => "native-id");
    vi.stubGlobal("crypto", { randomUUID });
    expect(randomEntryId()).toBe("native-id");
    expect(randomUUID).toHaveBeenCalledOnce();
  });
});
