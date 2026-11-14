import { describe, expect, it, vi } from "vitest";
import {
  importLidlHistory,
  lidlReceiptText,
} from "../../src/server/lidl-client";
import { parseReceipt } from "../../src/lib/receipt-parser";
import { lidlReceiptText as fixture } from "../fixtures";

const html = `<html><body><pre>${fixture
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/Lopphind/g, "L&otilde;pphind")}</pre></body></html>`;
const detail = (id: string) => ({
  ticket: { id, isDeleted: false, htmlPrintedReceipt: html },
});
const item = (id: string) => ({
  id,
  totalAmount: 2.93,
  badges: { isAvailable: true },
});

describe("Lidl account imports", () => {
  it("decodes printed HTML, preserving receipt rows and exact reconciliation", () => {
    const text = lidlReceiptText(detail("first"), "first")!;
    expect(parseReceipt(text)).toMatchObject({
      valid: true,
      total: 293,
      number: "TEST-LIDL-1001",
    });
    expect(text).not.toContain("<pre>");
    expect(text).toContain("Lõpphind");
  });
  it("rejects missing HTML or a mismatched identity and skips deleted receipts", () => {
    expect(() => lidlReceiptText(detail("other"), "first")).toThrow(
      "different",
    );
    expect(
      lidlReceiptText(
        { ticket: { ...detail("first").ticket, isDeleted: true } },
        "first",
      ),
    ).toBeNull();
    expect(() =>
      lidlReceiptText({ ticket: { id: "first" } }, "first"),
    ).toThrow();
    expect(() =>
      lidlReceiptText(
        { ticket: { id: "first", isDeleted: false, htmlPrintedReceipt: "" } },
        "first",
      ),
    ).toThrow("printed copy");
  });
  it("imports a receipt that disagrees with its history total instead of stopping", async () => {
    const changed = detail("changed");
    changed.ticket.htmlPrintedReceipt = html.replace("1,35 A", "1,36 A");
    const saved: Array<[string, string | null, number]> = [];
    const count = await importLidlHistory(
      {
        json: async (path) =>
          path.includes("page=1")
            ? {
                page: 1,
                size: 3,
                totalCount: 3,
                items: [item("changed"), item("deleted"), item("after")],
              }
            : path.includes("/changed?")
              ? changed
              : path.includes("/deleted?")
                ? { ticket: { id: "deleted", isDeleted: true } }
                : detail("after"),
      },
      async () => false,
      async (id, text, total) => {
        saved.push([id, text, total]);
      },
    );
    expect(count).toBe(2);
    expect(
      saved.map(([id, text, total]) => [id, text !== null, total]),
    ).toEqual([
      ["changed", true, 293],
      ["deleted", false, 293],
      ["after", true, 293],
    ]);
  });
  it("follows all pages, skips known and unavailable receipts, and retries partial imports without duplication", async () => {
    const saved = new Map<string, string>();
    saved.set("known", "existing");
    let failing = true;
    const json = vi.fn(async (path: string) => {
      if (path.includes("page=1"))
        return {
          page: 1,
          size: 2,
          totalCount: 4,
          items: [item("known"), item("new")],
        };
      if (path.includes("page=2")) {
        if (failing) throw new Error("temporary outage");
        return {
          page: 2,
          size: 2,
          totalCount: 4,
          items: [
            item("last"),
            { ...item("unavailable"), badges: { isAvailable: false } },
          ],
        };
      }
      return detail(path.includes("/new?") ? "new" : "last");
    });
    const has = async (id: string) => saved.has(id);
    const save = async (id: string, text: string | null) => {
      saved.set(id, text ?? "");
    };
    await expect(importLidlHistory({ json }, has, save)).rejects.toThrow(
      "outage",
    );
    expect(saved.has("new")).toBe(true);
    failing = false;
    expect(await importLidlHistory({ json }, has, save)).toBe(1);
    expect([...saved.keys()]).toEqual(["known", "new", "last"]);
    expect(
      json.mock.calls.filter(([path]) => path.includes("/new?")).length,
    ).toBe(1);
    expect(await importLidlHistory({ json }, has, save)).toBe(0);
  });
  it("does not silently complete on truncated or repeated history", async () => {
    const has = async () => true;
    const save = vi.fn();
    await expect(
      importLidlHistory(
        {
          json: async () => ({ page: 1, size: 10, totalCount: 20, items: [] }),
        },
        has,
        save,
      ),
    ).rejects.toThrow("before all");
    await expect(
      importLidlHistory(
        {
          json: async (path) => ({
            page: path.includes("page=1") ? 1 : 2,
            size: 1,
            totalCount: 2,
            items: [item("repeated")],
          }),
        },
        has,
        save,
      ),
    ).rejects.toThrow("repeated");
  });
  it("leaves an unreconciled basket for the existing review workflow", () => {
    const value = detail("review");
    value.ticket.htmlPrintedReceipt = html.replace("1,35 A", "1,34 A");
    expect(parseReceipt(lidlReceiptText(value, "review")!).valid).toBe(false);
  });
});
