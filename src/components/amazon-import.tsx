"use client";
import { ISODateInput } from "./iso-date-input";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Upload } from "lucide-react";
import { api, ErrorMessage, SectionTitle, type AppContext } from "./ui";
import { downloadAmazonInvoices } from "../lib/amazon-browser";

export function AmazonImport({ context: ctx }: { context: AppContext }) {
  const today = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Tallinn",
  }).format(new Date());
  const [from, setFrom] = useState(`${Number(today.slice(0, 4)) - 1}-01-01`);
  const [to, setTo] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const shortcut = useRef<HTMLAnchorElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const valid =
    /^\d{4}-\d{2}-\d{2}$/.test(from) &&
    /^\d{4}-\d{2}-\d{2}$/.test(to) &&
    from <= to &&
    Number(to.slice(0, 4)) - Number(from.slice(0, 4)) <= 5;
  useEffect(() => {
    // This is an owner-controlled bookmark shortcut, never received retailer JS.
    shortcut.current?.setAttribute(
      "href",
      valid
        ? `javascript:${encodeURIComponent(`void (${downloadAmazonInvoices.toString()})(${JSON.stringify({ from, to })}).catch(e=>alert(e.message))`)}`
        : "#",
    );
  }, [from, to, valid]);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    setResult("");
    try {
      const form = new FormData();
      form.set("retailer", "amazon");
      for (const selected of Array.from(files)) form.append("files", selected);
      const response = await api<{
        results: Array<{
          filename: string;
          error?: string;
          duplicate?: boolean;
        }>;
      }>("receipts/upload", form);
      const successful = response.results.filter((r) => !r.error);
      const duplicates = successful.filter((r) => r.duplicate).length;
      setResult(
        `${successful.length} invoices received${duplicates ? ` (${duplicates} already imported)` : ""}. Receipts are being checked and matched to payments.`,
      );
      setError(
        response.results
          .filter((r) => r.error)
          .map((r) => r.error)
          .join(" ") || null,
      );
      ctx.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  };
  return (
    <section className="panel">
      <SectionTitle
        title="Amazon.de invoices"
        description="Import invoices from your personal Amazon account for a selected order period."
      />
      <div className="padded-form">
        <ErrorMessage message={error} />
        <div className="form-grid">
          <label>
            Amazon orders from
            <ISODateInput
              value={from}
              max={to || undefined}
              required
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            Amazon orders through
            <ISODateInput
              value={to}
              min={from || undefined}
              required
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </div>
        <ol className="amazon-steps">
          <li>
            Drag{" "}
            <a
              ref={shortcut}
              draggable
              className="text-link"
              onClick={(e) => {
                e.preventDefault();
                ctx.notify(
                  "Drag the shortcut to your bookmarks bar, then use it while viewing your Amazon orders.",
                );
              }}
            >
              Download Amazon invoices
            </a>{" "}
            to your bookmarks bar. Replace the saved shortcut when you change
            the period.
          </li>
          <li>
            <a
              className="text-link"
              href="https://www.amazon.de/-/en/your-orders/orders"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Amazon orders <ArrowUpRight size={14} />
            </a>
            , sign in, and click the saved shortcut. It downloads all available
            invoice PDFs as one invoice pack.
          </li>
          <li>
            Import the downloaded pack here. You can also upload individual
            Amazon invoice PDFs.
          </li>
        </ol>
        {!valid && (
          <p className="form-help">
            Choose a valid period of at most six calendar years.
          </p>
        )}
        <div className="button-row">
          <input
            ref={file}
            type="file"
            accept=".amazon.json,.pdf"
            multiple
            className="visually-hidden"
            aria-label="Amazon invoice files"
            disabled={busy}
            onChange={(e) => void upload(e.target.files)}
          />
          <button
            className="button primary"
            disabled={busy}
            onClick={() => file.current?.click()}
          >
            <Upload size={16} />
            {busy ? "Importing…" : "Import Amazon invoices"}
          </button>
        </div>
        {result && <p role="status">{result}</p>}
        <small>
          Orders without a downloadable invoice stay in review. Downloads use
          your Amazon browser session.
        </small>
      </div>
    </section>
  );
}
