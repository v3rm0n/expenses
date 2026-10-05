// Self-contained so the same function can run as an Amazon bookmark shortcut.
// It uses the owner's signed-in browser; login cookies never leave Amazon.
export async function downloadAmazonInvoices(options: {
  from: string;
  to: string;
  download?: boolean;
}) {
  if (location.hostname !== "www.amazon.de")
    throw new Error("Open Amazon.de and sign in before using this shortcut.");
  const { from, to } = options;
  const validDate = (date: string) => {
    const parsed = new Date(`${date}T12:00:00Z`);
    return (
      !Number.isNaN(parsed.valueOf()) &&
      parsed.toISOString().slice(0, 10) === date
    );
  };
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
    !validDate(from) ||
    !validDate(to) ||
    from > to ||
    Number(to.slice(0, 4)) - Number(from.slice(0, 4)) > 5
  )
    throw new Error("Choose an order period of at most six calendar years.");
  if (document.getElementById("expenses-amazon-download"))
    throw new Error("An Amazon invoice download is already running.");
  const panel = document.createElement("div");
  panel.id = "expenses-amazon-download";
  panel.style.cssText =
    "position:fixed;top:20px;right:20px;z-index:2147483647;max-width:360px;background:white;color:#23392a;border:1px solid #b7c9bb;border-radius:8px;padding:20px;font:14px sans-serif;box-shadow:0 4px 24px #0003";
  const status = document.createElement("p");
  status.textContent = "Finding Amazon invoices…";
  const cancel = document.createElement("button");
  cancel.textContent = "Cancel";
  panel.append(status, cancel);
  document.body.append(panel);
  const controller = new AbortController();
  cancel.onclick = () => controller.abort();
  const pack = {
    format: "expenses-amazon-invoices",
    version: 1,
    from,
    to,
    invoices: [] as Array<{
      orderId: string;
      filename: string;
      pdf: string;
    }>,
    missing: [] as string[],
  };
  const origin = "https://www.amazon.de";
  const months = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const parse = (html: string) =>
    new DOMParser().parseFromString(html, "text/html");
  const get = async (url: string) => {
    if (new URL(url, origin).origin !== origin)
      throw new Error("Amazon returned an unexpected invoice address.");
    const response = await fetch(url, {
      credentials: "same-origin",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
    });
    if (!response.ok || new URL(response.url).origin !== origin)
      throw new Error(
        "Amazon could not return the invoices. Retry the download.",
      );
    if (/\/ap\/|captcha/i.test(response.url))
      throw new Error("Sign in to Amazon.de, then run the shortcut again.");
    return response;
  };
  const seen = new Set<string>();
  let totalBytes = 0;
  try {
    for (
      let year = Number(to.slice(0, 4));
      year >= Number(from.slice(0, 4));
      year--
    ) {
      // Amazon's own fallback serves readable cards to a document without JS.
      let url = `${origin}/-/en/your-orders/orders?disableCsd=missing-library&timeFilter=year-${year}`;
      const pages = new Set<string>();
      for (let page = 0; page < 100; page++) {
        if (pages.has(url))
          throw new Error("Amazon repeated an order-history page.");
        pages.add(url);
        status.textContent = `Reading ${year} orders · ${pack.invoices.length} invoices found…`;
        const doc = parse(await (await get(url)).text());
        if (
          doc.querySelector(
            'input[type="password"], #ap_email_login, #captchacharacters',
          )
        )
          throw new Error("Sign in to Amazon.de, then run the shortcut again.");
        const cards = [...doc.querySelectorAll(".order-card")];
        if (
          !cards.length &&
          !/\bno orders\b|haven.t placed|\b0 orders\b/i.test(
            doc.body.textContent || "",
          )
        )
          throw new Error(
            "Amazon returned an unfamiliar order page. No orders were treated as imported.",
          );
        for (const card of cards) {
          const invoice = card.querySelector<HTMLAnchorElement>(
            'a[href*="/invoice/popover"]',
          );
          const orderId =
            (invoice &&
              new URL(invoice.getAttribute("href")!, origin).searchParams
                .get("orderId")
                ?.match(/^\d{3}-\d{7}-\d{7}$/)?.[0]) ||
            card.textContent?.match(/\b\d{3}-\d{7}-\d{7}\b/)?.[0];
          const date = card.textContent?.match(
            /\b(\d{1,2})\s+([A-Za-z]+)\s+(20\d{2})\b/,
          );
          const month = date ? months.indexOf(date[2].toLowerCase()) + 1 : 0;
          if (!orderId || !date || !month)
            throw new Error(
              "An Amazon order date could not be read. Retry from the English order page.",
            );
          const placed = `${date[3]}-${String(month).padStart(2, "0")}-${date[1].padStart(2, "0")}`;
          if (placed < from || placed > to || seen.has(orderId)) continue;
          seen.add(orderId);
          if (!invoice) {
            pack.missing.push(orderId);
            continue;
          }
          const popover = parse(
            await (
              await get(new URL(invoice.getAttribute("href")!, origin).href)
            ).text(),
          );
          if (
            popover.querySelector(
              'input[type="password"], #ap_email_login, #captchacharacters',
            )
          )
            throw new Error(
              "Sign in to Amazon.de, then run the shortcut again.",
            );
          const links = [
            ...popover.querySelectorAll<HTMLAnchorElement>("a[href]"),
          ]
            .map((a) => new URL(a.getAttribute("href")!, origin))
            .filter(
              (u) =>
                u.origin === origin &&
                /\/documents\/download\/[^/]+\/[^/]+\.pdf$/i.test(u.pathname),
            );
          if (!links.length) {
            pack.missing.push(orderId);
            continue;
          }
          for (let index = 0; index < links.length; index++) {
            status.textContent = `Downloading invoice ${pack.invoices.length + 1}…`;
            const response = await get(links[index].href);
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (
              String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-" ||
              bytes.length > 15 * 1024 * 1024
            )
              throw new Error(
                "Amazon returned a missing or oversized invoice. Retry the download.",
              );
            totalBytes += bytes.length;
            if (totalBytes > 50 * 1024 * 1024 || pack.invoices.length >= 300)
              throw new Error(
                "This period is too large. Choose a shorter order period.",
              );
            let binary = "";
            for (let n = 0; n < bytes.length; n += 8192)
              binary += String.fromCharCode(...bytes.subarray(n, n + 8192));
            pack.invoices.push({
              orderId,
              filename: `amazon-${orderId}-${index + 1}.pdf`,
              pdf: btoa(binary),
            });
          }
        }
        const next = doc.querySelector<HTMLAnchorElement>(
          ".a-last a, a.a-pagination-next",
        );
        if (!next) break;
        const nextUrl = new URL(next.getAttribute("href")!, origin);
        nextUrl.searchParams.set("disableCsd", "missing-library");
        url = nextUrl.href;
        if (page === 99)
          throw new Error(
            "Amazon history exceeded the page limit. Choose a shorter period.",
          );
      }
    }
    if (options.download !== false) {
      const blob = new Blob([JSON.stringify(pack)], {
        type: "application/json",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `amazon-${from}-${to}.amazon.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }
    status.textContent = `${pack.invoices.length} invoices downloaded. ${pack.missing.length} orders have no downloadable invoice. Import the Amazon invoice pack in Expenses.`;
    cancel.textContent = "Close";
    cancel.onclick = () => panel.remove();
    return pack;
  } catch (error) {
    panel.remove();
    throw error;
  }
}
