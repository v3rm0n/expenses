# Personal expenses

A private, single-owner web app for bank transactions and itemized receipts. The responsive dashboard, transaction search, receipt review, classification rules, cash entries, and CSV exports work on phones and computers.

The application defaults to **127.0.0.1:4317**. Set `HOST=0.0.0.0` in `.env.local` to listen on all IPv4 interfaces for LAN or remote proxy access. PostgreSQL listens on **127.0.0.1:54329**. The worker runs alongside the web application.

## Getting started

Prerequisites: Node 22.13 or newer, npm, and Docker (or Colima on macOS). The runner can use Docker inside Colima if its host socket is unavailable.

From the repository root, install dependencies and create your private configuration:

```sh
npm ci
cp .env.example .env.local
```

Set `POSTGRES_PASSWORD` and the matching password in `DATABASE_URL`. Set `ENCRYPTION_KEY` to 64 hexadecimal characters and both `OWNER_SETUP_TOKEN` and `INBOUND_EMAIL_TOKEN` to independent random tokens of at least 24 characters. Generate each secret separately with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Keep `ENCRYPTION_KEY` stable: existing encrypted data and backups depend on it. Banking variables can remain empty until you configure the connection. Then build and start the app:

```sh
npm run build
npm start
```

`npm start` checks the database, starts its Compose container if needed, applies migrations, and starts both the web app and worker. Keep it running; Ctrl+C stops the app and worker. PostgreSQL retains data in the `expenses-db` Docker volume. `npm run dev` runs the same services with development reloads for the web app; restart it after worker changes.

To keep the app running after closing your terminal, use `npm run start:background`. Its private log is `.data/app.log`. Stop this managed background instance with `npm run stop`. This starts it on demand; no login/startup service is installed.

On first use, run the following in a second terminal:

```sh
npm run setup
```

Open the **setup link** it prints and choose your name and a password of at least 12 characters. The setup token is consumed logically by the creation of the single owner account; it cannot create a second owner. The app removes the token from the address bar. Sign in separately on your phone once the HTTPS proxy or Tailscale access is ready. There is no default password or demo data in your database.

Configuration lives in the ignored `.env.local`. Store the Enable Banking signing key outside the repository, for example at `~/.config/expenses/enable-banking.pem`, with owner-only permissions. Secrets are never sent to the browser, except the inbound email token when you explicitly reveal it in Settings. `.env.example` documents the variables for another installation; generate independent random secrets and keep the encryption key stable.

## Tailscale access

Set `HOST=0.0.0.0` and configure `ACCESS_URL=http://your-machine.your-tailnet.ts.net:4317` in `.env.local` so setup links and browser origin validation support your machine’s Tailscale address. `APP_URL` and the bank callback remain the public HTTPS address.

Connect the other device to your tailnet, then open the setup link from `npm run setup`. The application requires its owner login and also accepts connections on the LAN. Cash-entry identifiers support browsers using this HTTP address. Keep Tailscale Serve forwarding disabled on port 4317: it reserves the port and prevents the app from binding to all interfaces. Existing Tailscale services on other ports are independent.

## Reverse proxy and bank connection

Set `APP_URL` to your public HTTPS origin, such as **https://expenses.example.com**, and proxy it to the app on port 4317. If the proxy runs on another machine, set `HOST=0.0.0.0` and use the app machine’s LAN address; a DHCP reservation keeps it stable. Set `ENABLE_BANKING_REDIRECT_URL` to **https://expenses.example.com/callback** and register the same callback with Enable Banking. Proxy the entire application, including `/api/*` and `/callback`.

Preserve the host and overwrite forwarded headers with the real client information. An nginx example inside your HTTPS server block:

```nginx
location / {
    proxy_pass http://127.0.0.1:4317;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    client_max_body_size 100m;
    proxy_read_timeout 120s;
}
```

`TRUST_PROXY=true` lets the app use the client information supplied by your HTTPS reverse proxy. HTTPS forwarded requests receive Secure, HttpOnly, SameSite=Lax session cookies. Mutations check the browser origin. LHV and SEB require the real client IP for an online manual bank refresh. Scheduled imports do not invent online-user headers.

Open the public HTTPS address, sign in, and select a bank in **Connections**. LHV Pank, SEB, and Revolut are available in the Estonia catalogue. Revolut is also listed in Lithuania; choose the country appropriate to your account. Complete consent in the bank’s own interface. Configure `ENABLE_BANKING_APP_ID` and `ENABLE_BANKING_PRIVATE_KEY_PATH` in `.env.local` using your production application with AIS access. The API integration follows the [Enable Banking reference](https://enablebanking.com/docs/api/reference/).

Your Enable Banking personal application must have every intended account linked, including Revolut wallets. Reconnect after adding linked accounts or renewing consent. Account identities include the stable bank identification hash and currency; a shared IBAN does not collapse currency wallets. Existing history survives reconnection. Accounts omitted from renewed consent retain their history but stop synchronizing.

The first synchronization requests the longest available history. Later imports fetch an overlapping 14-day window, follow every continuation page, and commit an account checkpoint only after its complete result is imported. Daily scheduling and durable retries run in the worker. Actual historical availability and consent duration depend on the bank. The UI shows expiry, last successful import, errors, and manual refresh. Disconnect requests deletion of the Enable Banking session; the provider closes the bank consent where supported.

## Investment and pension contributions

Outgoing transfers to investment accounts and pension providers are recorded separately from spending. **Money set aside** shows monthly contributions, money returned, contribution totals from imported history through the selected month, and a six-month table. Each currency stays separate. These totals describe bank transfers, not investment values or pension balances. Net cash flow includes contributions and money returned; spending charts and receipt coverage exclude them.

Outgoing Lightyear and Tuleva payments are recognised as investment transfers; Pensionikeskus payments are pension contributions. Explicitly labelled investment-account or pension-contribution payments are also recognised automatically. Bank names alone do not imply investments. Incoming payments remain income or transfers unless manually marked, so salaries from a broker remain income. In a transaction's **Payment type**, choose **Investment transfer** or **Pension contribution**; a positive payment records money returned. Manual classifications survive future imports. For other destinations, create a merchant or payment-description rule assigned to **Investment transfers** or **Pension contributions**, and apply it to history. Ordinary transfers between your accounts remain separate unless explicitly identified as contributions.

## Import receipts

Export or share receipts from Rimi, Partnerkaart/Selver, Coop, Lidl, Wolt, or Amazon.de, then upload them in **Receipts**. Supported originals: PDF, PNG, JPEG, CSV, TXT, and forwarded `.eml` email files. CSV attachments also import through the email bridge. There is a 15 MB limit per receipt, 20 MB per email, 20 files per batch, and 100 MB per batch. PDFs allow at most 20 pages. Digital PDFs use their text layer; images and scanned PDFs use local English/Estonian OCR. On first image import the OCR engine downloads language models, then caches them locally. Receipt documents themselves stay on this machine.

Source profiles detect retailer, purchase date, receipt number, product lines, quantities, discounts, deposits, totals, and card/cash tender lines where the export exposes them. Item amounts must reconcile exactly with the total before automatic matching. Unknown layouts, unreadable originals, missing dates, and discrepancies enter **Review**. The editor lets you correct metadata and lines, choose product categories, and remember product mappings.

Rimi's image-only digital receipt layout is supported: wrapped product names, quantity/unit-price rows, `Allah.` discounts with the printed `Uus hind`, and `ARVE NR` receipt numbers. Product amounts include their discounts. Redeemed Rimi loyalty money reduces product amounts proportionally while preserving container deposits; repeated discount summaries and loyalty balances are excluded. The parser handles spaced decimals and common OCR label errors. A single misread price digit can be recovered from an integer quantity and unit price only when the full basket reconciles. A damaged total can be recovered only when both printed card-payment copies and the basket agree. Unresolved discrepancies remain in Review. Scanned-PDF and MIME-attachment regression tests use synthetic receipts.

Selver/Partnerkaart semicolon CSV exports are supported, including UTF-8 BOMs, quoted fields, comma decimal amounts, fractional quantities, and repeated product rows. The basket total is kept separate from the VAT summary, `PARTNERAPP` is recognized as a card payment, and receipt identity comes from the `TŠEKK;KUUPÄEV;AEG;KASSA` footer. Redeemed `BOONUSRAHA` reduces the receipt total and is distributed proportionally across product amounts using exact cents, preserving bottle deposits. The original basket must reconcile with card, cash, and bonus payments before this reduction; bank matching uses the amount paid after bonus redemption. The original file retains the printed amounts. Quantities retain the exported value; the file does not specify their units. The supplied Selver export reconciles 17 product lines to €54.07. Basket and payment discrepancies enter Review.

Automatically match only a unique booked payment with the same currency, merchant, exact amount, and booking date from one day before to seven days after the purchase. Pending bank payments appear in the manual link dropdown with a Pending label. An explicit link reserves the receipt amount without adding pending payments to spending totals; the receipt shows that it is waiting for booking. When a unique pending-to-booked match exists in both directions, receipt links and manual categories move to the booked payment. Ambiguous matches keep the pending association for review. Competing identical payments stay for review. Manual links support split payments while enforcing both receipt and transaction limits. Cash receipts become ledger expenses only when you explicitly record their cash payment. Uploading a receipt does not add another expense to an existing bank payment.

SEB repeats its pending list on every history page; this is handled without multiplying payments. Per-page counts preserve genuinely identical purchases returned together. After the complete history fetch succeeds, the current pending snapshot retires old reference-less copies within the sync window, including payments that have since booked or disappeared. Receipt links and manual corrections are protected. Other banks retain their existing import behavior.

Original-file hashes prevent repeat uploads. Receipt number/date/merchant/currency identities also detect the same receipt in different exports. A conflicting total goes to review. Originals remain available behind owner authentication.

Lidl PNG receipts use local OCR and a dedicated product-code/quantity/price parser. Explicit discounts are separate lines; repeated `Lõpphind`, VAT, and card-terminal details are excluded. Product amounts, discount summaries, and card/cash totals must reconcile. The supplied image reconciles 13 products and four discounts to €21.00.

Wolt email receipts are supported, including separate food and delivery PDFs, wrapped product names, promotional discounts, courier tips, and service fees. The order ID and full total from the email associate the originals; automatic matching waits until the documents reconcile to that full amount and a unique Wolt bank payment. Restaurant items and fees use the Restaurants category. Standalone Wolt PDFs can be reviewed and linked manually; without the full email order total they do not automatically match a partial invoice to a bank payment.

Coop digital PDFs with the `Toode Kogus Kokku` table are supported, including fractional quantities, repeated deposit rows, wrapped names, and separate card/cash payments. The header `Summa`, basket `Kokku`, product sum, and payments must reconcile; VAT and loyalty-card details are excluded. Coop, Konsum, and Maksimarket bank merchant names are recognised for unique payment matching. The supplied Coop PDF reconciles five lines to €5.67 (€5.47 groceries and €0.20 deposits). The automated fixtures are synthetic. Lidl also supports authenticated automatic imports through its Estonia website; other retailers use app/web exports and email ingestion. Link-only retailer emails stay in Review and require an exported receipt. Some receipt layouts will initially need correction.

## Import Amazon.de invoices

For a personal Amazon.de account, open **Settings → Amazon.de invoices**, choose an order period, and drag **Download Amazon invoices** to your bookmarks bar. Open the linked English Amazon order history, sign in, then click the saved shortcut. It follows every order-history page and downloads all available invoice PDFs as one `.amazon.json` pack. Replace the saved shortcut after changing the period. Import the pack in Settings or Receipts; individual Amazon PDFs can also be uploaded. Each pack allows 300 invoices, 15 MB per PDF, 50 MB of PDFs, and 70 MB of JSON.

The shortcut runs in your signed-in Amazon browser session. Credentials and cookies are never sent to Expenses. German and English invoice layouts parse product amounts, delivery charges, discounts, invoice dates, order IDs, and credit notes. Delivery and discounts are distributed across product categories. Separate charges match individual invoices; complete order packs can match a combined charge only when every invoice reconciles and the payment is unique within all invoice date windows. Repeated imports deduplicate originals and retain manual categories. Unavailable invoices, unsupported seller layouts, and ambiguous payments remain available for review.

## Automatically import Lidl Plus receipts

Install the Chromium browser once with `npx playwright install chromium`, then open **Settings → Lidl Plus receipts**. Enter your Lidl Estonia email and password and enable **Import receipts daily**. Saving queues the first import; **Import now** queues another check. Restart the worker after installing this update.

The worker signs in through `www.lidl.ee` and its `accounts.lidl.com` login, then reads the website's digital-receipt history, following every page. Credentials and reusable browser sessions are encrypted with your existing `ENCRYPTION_KEY`; they are never returned to the browser or placed in queue jobs. The printed receipt HTML is converted to plain text and stored as an owner-only original, without loading retailer scripts or images. Receipts use the existing parser, reconciliation, review, categorization, duplicate detection, and payment matching. Imports do not create additional bank expenses.

Imported retailer receipt IDs prevent repeated downloads. Partial failures retain completed receipts and retry the remaining history. Import activity and the connection show errors and last success. Pausing daily imports retains credentials; **Disconnect** removes credentials and session while retaining receipts. The connection uses Lidl's website endpoints, which may change, and sign-in may require interactive verification; failures are reported instead of being treated as an empty history. Only Estonia's printed HTML receipts are currently supported.

For local setup, optionally put `LIDL_USERNAME` and `LIDL_PASSWORD` in your ignored `.env.local`, then run `npm run lidl:connect`. This encrypts the connection in the database and runs an initial import. Remove those two variables afterward. If Lidl requires verification, run `npm run lidl:connect -- --interactive` and complete sign-in in the Chromium window; this can reuse the credentials saved in Settings. If using an existing Chromium installation, set `LIDL_BROWSER_EXECUTABLE_PATH` to its executable path. Do not place account credentials in `.env.example` or source code.

## Receive forwarded receipts at a free address

The included [Cloudflare email bridge](integrations/cloudflare/README.md) receives forwarded receipts for a domain using Cloudflare nameservers. Use a dedicated subdomain, such as `receipts.example.com`, and an address such as **receipts@receipts.example.com**. This preserves the root domain’s existing mail delivery.

Cloudflare Email Routing is a managed inbound service, not a mailbox you must maintain. Its Email Worker stores original MIME messages in KV and posts them to `/api/inbound/email` using an independent bearer token. It retries every 15 minutes and retains undelivered messages for seven days while the local machine is offline. Email Routing is free; Worker/KV usage must stay within the [current free plan limits](https://developers.cloudflare.com/email-service/platform/pricing/). Deploy the Worker and configure the routing rule using the bridge instructions.

Settings always shows the Received email section. A delivered email appears even if its content cannot be parsed. If no email appears there, check the Cloudflare routing rule, Worker logs, and pending `email:` keys in KV; a buffered message will be retried every 15 minutes.

To set up Gmail forwarding, add your receipt address in Gmail’s forwarding settings. Google sends a confirmation email to that address. Open **Settings → Received email → Open message** to read it, copy the confirmation code, or open the Gmail confirmation link. Then return to Gmail to enable forwarding or create a receipt filter. Forwarding confirmations have a separate `verification` status and do not create receipts. Previously received messages in Review can also be opened. Message bodies are displayed as plain text without loading remote images.

Email ingestion preserves the raw message, extracts supported attachments or a readable receipt body, and queues receipt processing separately. Message viewing, raw email downloads, and retries are available in Settings.

## Classification and reporting

Amounts are integer currency minor units, including zero- and three-decimal currencies. EUR, USD, GBP, and other currencies have separate views; there is no invented exchange conversion. Choose currency and month in the app. The timezone is Europe/Tallinn.

Expense totals include booked bank and recorded cash purchases, with refunds subtracted. Pending transactions, own-account transfers, and ATM withdrawals do not count as spending. A withdrawal remains unallocated cash until actual cash purchases are recorded. Own-account transfer detection uses known account IBANs; inspect older payments after connecting additional banks and correct ambiguous types. Incoming payments without a refund marker initially classify as income; use the payment editor to correct unmarked refunds.

Manual transaction categories take precedence. Automatic entries use your merchant/description rules, validated receipt product splits, then merchant/MCC fallback. Product mappings and product rules improve receipt categories. Create prioritized rules, preview matches, and choose whether to apply them to existing automatic entries. Corrections are audited and are retained across reimports. Merchant/MCC/product inference is transparent and deliberately leaves unknown cases uncategorized.

Overview includes spending, income, net flow, receipt coverage, category breakdowns, merchants, a six-month trend, pending payments, and unallocated cash. Transactions support search and filters for account, category, type, receipt presence, amount, and status. Settings exports expenses, category allocations, and receipt products as CSV, with spreadsheet formula escaping.

## Back up and restore

```sh
npm run backup
# Or choose an output file:
npm run backup -- /path/to/expenses.enc
```

Backups contain a PostgreSQL snapshot and original receipt/email files, encrypted with AES-256-GCM using `ENCRYPTION_KEY`. Originals are immutable and retained; the database is dumped first, then originals are copied so every file referenced by the snapshot is included. A live backup may include additional unreferenced files uploaded during the dump, which does not duplicate ledger entries. Queue jobs and OCR caches are excluded. After restore, the worker recreates its queues and recovers unfinished imports from the database.

Copy encrypted backups off this machine and keep **the original encryption key and signing key separately**. The backup does not contain `.env.local` or the signing key. Restoring without the original encryption key is impossible. A new backup filename is generated on every run. Schedule `npm run backup` using your preferred local scheduler; no automatic retention/delete policy has been installed.

To replace the configured database, stop the app and worker first, retain your `.env.local`, then run:

```sh
npm run restore -- /path/to/expenses.enc --confirm-replace
npm start
```

The explicit replacement flag prevents accidental CLI restores. The archive is authenticated and checked before touching the database. Database restoration uses a single transaction. Original files are restored, cached jobs are discarded, and browser sessions/bank authorization states are cleared. A full encrypted backup/restore and tamper rejection were verified against isolated databases.

## Checks

```sh
npm run format:check
npm test
npm run test:integration
npm run test:e2e
npm run typecheck
npm run build
```

Integration/browser checks create temporary databases and document directories and leave your real owner and financial data untouched. PostgreSQL must be running (`npm run db:start`), and `DATABASE_URL` in `.env.local` must use a role allowed to create temporary databases. Next.js generates `next-env.d.ts` and route types during `npm run build` or `npm run dev`; run a build before typechecking a fresh clone. Browser tests use port 4318 and a separate Next output directory. Install Chromium with `npx playwright install chromium` if needed; on this Mac the tests can reuse an existing cached Chromium, or specify `PLAYWRIGHT_EXECUTABLE_PATH`.

Tests exercise exact money, currencies, discounts, receipt reconciliation, repeated imports, pending/booked transitions, refunds, own transfers, immutable manual categories, ambiguous and split matching, PDF extraction, forwarded MIME, bank pagination/failure checkpoints, consent renewal/state replay, encrypted backup/restore, owner setup, phone layout, CSRF, and email API authentication. Live bank consent, real retailer formats, and deployed inbound mail still need validation with your accounts.

## Structure

- `src/app`, `src/components`: Next.js web app and responsive interface.
- `src/server`: authentication, bank integration, ledger, receipts, email, reporting, and API.
- `src/lib`: currency math, deterministic classification, and receipt source profiles.
- `migrations`: PostgreSQL schema.
- `scripts`: local runner, worker, setup, database tools, and backup/restore.
- `integrations/cloudflare`: deployable inbound Email Worker and configuration.
- `tests`: synthetic fixtures, unit checks, and browser workflows.

The web app/worker run as local Node processes; Compose manages PostgreSQL. This adapts the original [implementation plan](PLAN.md) to your requested local hosting. Full application containers, PWA offline caching, additional retailer account synchronization, currency conversion, budgets, and model-based suggestions are later extensions.
