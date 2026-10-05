import { describe, expect, it } from "vitest";
import {
  suggestedDescriptionPattern,
  matchesSimilarTransaction,
} from "../../src/lib/similar-transactions";

describe("similar transaction descriptions", () => {
  it("matches SEB package charges across references and billing months", () => {
    const pattern = suggestedDescriptionPattern(
      "RO4000000001L01 · 1000000-Esmaklassiline pakett - septembri kuutasu",
    );
    expect(pattern).toBe("Esmaklassiline pakett");
    expect(
      matchesSimilarTransaction(
        {
          merchant: " SEB ",
          description:
            "RO4000000002L01 · 1000000-Esmaklassiline pakett - augusti kuutasu",
        },
        "seb",
        pattern,
      ),
    ).toBe(true);
    expect(
      matchesSimilarTransaction(
        { merchant: "SEB", description: "Other service fee" },
        "SEB",
        pattern,
      ),
    ).toBe(false);
    expect(
      matchesSimilarTransaction(
        { merchant: "Another bank", description: pattern },
        "SEB",
        pattern,
      ),
    ).toBe(false);
  });
  it("supports merchant-only matching and treats punctuation literally", () => {
    expect(suggestedDescriptionPattern("")).toBe("");
    expect(
      matchesSimilarTransaction(
        { merchant: "SHOP", description: "anything" },
        "Shop",
        "",
      ),
    ).toBe(true);
    expect(
      matchesSimilarTransaction(
        { merchant: "Shop", description: "fee 100%" },
        "Shop",
        "100%",
      ),
    ).toBe(true);
    expect(
      matchesSimilarTransaction(
        { merchant: "Shop", description: "fee 1000" },
        "Shop",
        "100%",
      ),
    ).toBe(false);
  });
});
