# Personal expenses guide

Setup, integrations, receipt handling, reporting, and maintenance for Personal expenses. See the [project overview](README.md) for a summary of the application.

## Contents

- [Getting started](#getting-started)
- [Running with Docker](#running-with-docker)
- [Tailscale access](#tailscale-access)
- [Reverse proxy and bank connection](#reverse-proxy-and-bank-connection)
- [Investment and pension contributions](#investment-and-pension-contributions)
- [Import receipts](#import-receipts)
- [Import Amazon.de invoices](#import-amazonde-invoices)
- [Automatically import Lidl Plus receipts](#automatically-import-lidl-plus-receipts)
- [Receive forwarded receipts at a free address](#receive-forwarded-receipts-at-a-free-address)
- [Classification and reporting](#classification-and-reporting)
- [Back up and restore](#back-up-and-restore)
- [Checks](#checks)
- [Structure](#structure)

## Getting started

The application defaults to **127.0.0.1:4317**. Set `HOST=0.0.0.0` in `.env.local` to listen on all IPv4 interfaces for LAN or remote proxy access. PostgreSQL listens on **127.0.0.1:54329**. The worker runs alongside the web application.

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

## Running with Docker

Copy `.env.example` to `.env.local` and generate the secrets described above. Use a random hexadecimal `POSTGRES_PASSWORD` so it is safe to embed in the database URL. Configure `APP_URL`, `ACCESS_URL`, and optional integration credentials for your installation.

The container runs the web app and worker together, applies migrations, and connects to the separate PostgreSQL service. Start both services with:

```sh
docker compose --env-file .env.local -f compose.yaml -f compose.container.yaml pull
docker compose --env-file .env.local -f compose.yaml -f compose.container.yaml up -d
docker compose --env-file .env.local -f compose.yaml -f compose.container.yaml exec app npm run setup
```

Open the printed setup link to create the owner account. The app listens on `127.0.0.1:4317` on the host; use an HTTPS reverse proxy for remote access. The Compose override supplies the internal database URL and stores original documents, OCR cache, and browser state in the `expenses-data` volume. PostgreSQL keeps the existing `expenses-db` volume. Keep both volumes when updating; `docker compose down -v` removes their data.

To update, repeat the `pull` and `up -d` commands. Set `EXPENSES_IMAGE=ghcr.io/v3rm0n/expenses:sha-<full-commit-sha>` in `.env.local` to select a particular published commit instead of `latest`.

Bank signing keys must be mounted separately, read-only, and `ENABLE_BANKING_PRIVATE_KEY_PATH` must point to their path inside the container. If the GHCR package is private, authenticate with `docker login ghcr.io` before pulling. The existing backup/restore scripts expect the local Docker CLI and database Compose service; run them on the host, with access to the documents in the `expenses-data` volume.

Build and run a local image with:

```sh
docker build -t expenses:local .
EXPENSES_IMAGE=expenses:local docker compose --env-file .env.local -f compose.yaml -f compose.container.yaml up -d
```

The [publishing workflow](.github/workflows/container.yml) runs on every push to `main` and can also be started manually from GitHub Actions. It uses the repository's `GITHUB_TOKEN` with package write permission; no registry password needs to be added to repository secrets. Build inputs exclude local environment files, signing keys, documents, backups, and Git history.

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

## Double-entry accounting

Every booked transaction creates a journal with equal debits and credits in its currency. Pending and superseded transactions have no postings. The migration converts existing booked history automatically, retaining transaction identities, receipt links, and category splits. Database triggers keep journals synchronized when imports, classifications, receipt splits, or cash entries change. Spending reports read the balanced journal; receipts remain supporting documents and do not create an extra expense.

A purchase debits its expense categories and credits the paying bank or cash account; a refund reverses these postings. Income debits the receiving account and credits Income. ATM withdrawals debit the shared cash account and credit the bank account. Each side of an imported own-account transfer posts against Transfer clearing, so importing both sides clears the movement without counting either bank balance twice. An unmatched transfer stays in clearing. Currencies remain separate, including currency exchanges; the app does not translate currencies or calculate exchange gains and losses.

**Advanced → Accounts** shows account balances and total posted debits and credits for the selected currency across all recorded history. **Journal postings** in a transaction shows its debits and credits. Historical balances start at zero: bank-supplied balance snapshots are not used to invent historical opening balances. Use **Edit opening balance** to enter the balance at the beginning of a date on or before the first recorded movement in that account; it posts against Opening balances equity. Saving a replacement adjusts the opening journal, and entering zero removes it. If you change the import period or import earlier history, review opening balances to avoid omitting or counting those movements twice.

Investment and pension transfers debit asset accounts rather than expenses. Their balances equal opening balances plus contributions minus withdrawals, assuming no change in value. When the destination IBAN belongs to an account already tracked in the app, the movement uses Transfer clearing so its imported receiving side supplies the asset balance without duplicating it. No market valuation, interest, dividends, or trading gains are inferred. Existing contribution reports keep their current cash-flow meaning.

The original transaction and allocation tables retain imported data and classification inputs. The accounting tables are `ledger_accounts`, `journal_entries`, and `journal_postings`; positive posting amounts are debits and negative amounts are credits, with explicit generated debit and credit columns. Foreign keys prohibit mixed-currency journals, and deferred database constraints reject missing or unbalanced journals at commit. Corrections replace postings atomically while retaining the source transaction; this is an editable personal ledger rather than a locked accounting-period system.

Authenticated endpoints: `GET /api/accounting/trial-balance?currency=EUR&through=2026-01-31` (the date is optional), `GET /api/accounting/transactions/:id`, and `POST /api/accounting/opening-balance` with `{ "accountId": "ledger-account-uuid", "amount": "1000.00", "date": "2026-01-01" }`. Run `npm run test:accounting` for migration, balancing, corrections, opening balances, transfers, cash, and currency regression checks in an isolated database.

## Advanced bookkeeping

The **Advanced** menu provides a separate workspace for the full ledger. Select the currency in the page header; every journal and account uses a single currency.

- **Journal** lists imported, opening, and manual entries. Filter by dates, source, description, reference, or notes, and open an entry to inspect its postings. **New journal entry** accepts a date, description, reference, notes, and 2–100 account lines. Each line has a positive debit or credit and an optional memo. Debits and credits must match exactly before posting. Manual journals can be edited or deleted; version checks prevent overwriting another edit, and retrying a submitted form does not create a duplicate. Imported journals are inspected here and corrected through their source transaction; opening entries are managed in Accounts.
- **General ledger** shows one account's dated postings, period debits and credits, opening balance from earlier history, running balances, and closing balance. Running balances and totals cover the entire period even when the result spans multiple pages. Click an account in another view to open its ledger, or click a posting to inspect its journal.
- **Trial balance** shows each account's net debit or credit balance through a chosen date, with equal column totals. These are net balances, distinct from the total posted debits and credits shown in Accounts.
- **Accounts** lets you add assets, liabilities, equity, income, and expense accounts. User-entered account codes are unique within each currency. Existing bank, cash, category, and system accounts remain available for manual postings. Asset opening balances can be entered here.
- **Financial statements** shows income, expenses, and net income for a period, plus assets, liabilities, equity, and accumulated earnings through its end date. The balance sheet includes earlier history; accumulated earnings include the net balance of income and expense accounts that has not been closed into equity.

Advanced reports include manual journals alongside imported transactions and opening entries. Manual journals do not create bank transactions or receipt payments, so the regular expense Overview and Transactions screens retain their bank-and-receipt reporting scope. Manual expense or income accounts can be used without attaching a spending category.

Additional authenticated endpoints: `GET/POST /api/accounting/journals`, `GET/POST/DELETE /api/accounting/journals/:id`, `POST /api/accounting/accounts`, `GET /api/accounting/general-ledger?account=:id&from=2026-01-01&to=2026-01-31`, and `GET /api/accounting/statements?currency=EUR&from=2026-01-01&to=2026-01-31`. Manual journal creation takes `currency`, `date`, `description`, optional `reference` and `notes`, an `idempotencyKey` UUID, and `postings` with `accountId`, `debit`, `credit`, and optional `memo`. Amounts are decimal currency values. Updates take the entry's current `version` instead of an idempotency key; deletion takes `{ "version": 1 }`.

## Investment and pension contributions

Outgoing transfers to investment accounts and pension providers are recorded separately from spending. **Goals** shows monthly and annual contribution progress, money returned, year-to-date contribution history, totals from imported history through the selected month, and a monthly table. Overview keeps a compact progress summary, including goals with no contributions yet. Each currency stays separate. These totals describe bank transfers, not investment values or pension balances. Net cash flow includes contributions and money returned; spending charts and receipt coverage exclude them.

Outgoing Lightyear and Tuleva payments are recognised as investment transfers; Pensionikeskus payments are pension contributions. Explicitly labelled investment-account or pension-contribution payments are also recognised automatically. Bank names alone do not imply investments. Incoming payments remain income or transfers unless manually marked, so salaries from a broker remain income. In a transaction's **Payment type**, choose **Investment transfer** or **Pension contribution**; a positive payment records money returned. Manual classifications survive future imports. For other destinations, create a merchant or payment-description rule assigned to **Investment transfers** or **Pension contributions**, and apply it to history. Ordinary transfers between your accounts remain separate unless explicitly identified as contributions.

## Import receipts

Export or share receipts from Rimi, Partnerkaart/Selver, Coop, Lidl, Wolt, or Amazon.de, then upload them in **Receipts**. Supported originals: PDF, PNG, JPEG, CSV, TXT, and forwarded `.eml` email files. CSV attachments also import through the email bridge. There is a 15 MB limit per receipt, 20 MB per email, 20 files per batch, and 100 MB per batch. PDFs allow at most 20 pages. Digital PDFs use their text layer; images and scanned PDFs use local English/Estonian OCR. On first image import the OCR engine downloads language models, then caches them locally. Receipt documents themselves stay on this machine.

Source profiles detect retailer, purchase date, receipt number, product lines, quantities, discounts, deposits, totals, and card/cash tender lines where the export exposes them. Item amounts must reconcile exactly with the total before automatic matching. Unknown layouts, unreadable originals, missing dates, and discrepancies enter **Review**. The editor lets you correct metadata and lines, choose product categories, and remember product mappings.

Rimi's image-only digital receipt layout is supported: wrapped product names, quantity/unit-price rows, `Allah.` discounts with the printed `Uus hind`, and `ARVE NR` receipt numbers. Product amounts include their discounts. Redeemed Rimi loyalty money reduces product amounts proportionally while preserving container deposits; repeated discount summaries and loyalty balances are excluded. The parser handles spaced decimals and common OCR label errors. A single misread price digit can be recovered from an integer quantity and unit price only when the full basket reconciles. A damaged total can be recovered only when both printed card-payment copies and the basket agree. Unresolved discrepancies remain in Review. Scanned-PDF and MIME-attachment regression tests use synthetic receipts.

Selver/Partnerkaart digital PDF receipts are supported: product quantities, unit-price and discounted line-total columns, repeated products, campaign savings summaries, card/PartnerÄpp and cash payments, and redeemed bonus money. Printed totals, the basket, and tenders must reconcile before bank matching. Bonus money reduces the amount to match while preserving bottle deposits. PDF and CSV exports of the same receipt share duplicate detection.

Selver/Partnerkaart semicolon CSV exports are supported, including UTF-8 BOMs, quoted fields, comma decimal amounts, fractional quantities, and repeated product rows. The basket total is kept separate from the VAT summary, `PARTNERAPP` is recognized as a card payment, and receipt identity comes from the `TŠEKK;KUUPÄEV;AEG;KASSA` footer. Redeemed `BOONUSRAHA` reduces the receipt total and is distributed proportionally across product amounts using exact cents, preserving bottle deposits. The original basket must reconcile with card, cash, and bonus payments before this reduction; bank matching uses the amount paid after bonus redemption. The original file retains the printed amounts. Quantities retain the exported value; the file does not specify their units. The supplied Selver export reconciles 17 product lines to €54.07. Basket and payment discrepancies enter Review.

Automatically match only a unique booked payment with the same currency, merchant, exact amount, and booking date from one day before to seven days after the purchase. Pending bank payments appear in the manual link dropdown with a Pending label. An explicit link reserves the receipt amount without adding pending payments to spending totals; the receipt shows that it is waiting for booking. When a unique pending-to-booked match exists in both directions, receipt links and manual categories move to the booked payment. Ambiguous matches keep the pending association for review. Competing identical payments stay for review. Manual links support split payments while enforcing both receipt and transaction limits. Cash receipts become ledger expenses only when you explicitly record their cash payment. Uploading a receipt does not add another expense to an existing bank payment.

SEB repeats its pending list on every history page; this is handled without multiplying payments. Per-page counts preserve genuinely identical purchases returned together. After the complete history fetch succeeds, the current pending snapshot retires old reference-less copies within the sync window, including payments that have since booked or disappeared. Receipt links and manual corrections are protected. Other banks retain their existing import behavior.

Original-file hashes prevent repeat uploads. Receipt number/date/merchant/currency identities also detect the same receipt in different exports. A conflicting total goes to review. Originals remain available behind owner authentication.

Lidl PNG receipts use local OCR and a dedicated product-code/quantity/price parser. Explicit discounts are separate lines; repeated `Lõpphind`, VAT, and card-terminal details are excluded. Product amounts, discount summaries, and card/cash totals must reconcile. The supplied image reconciles 13 products and four discounts to €21.00.

Wolt email receipts are supported, including separate food and delivery PDFs, wrapped product names, promotional discounts, courier tips, and service fees. The order ID and full total from the email associate the originals; automatic matching waits until the documents reconcile to that full amount and a unique Wolt bank payment. Restaurant items and fees use the Restaurants category. Standalone Wolt PDFs can be reviewed and linked manually; without the full email order total they do not automatically match a partial invoice to a bank payment.

Maxima digital PDFs are supported, including unit prices multiplied by quantities, wrapped names, repeated bottle deposits, product discounts, and card/cash payments. VAT, earned loyalty money, and repeated footer discount details are excluded from the basket. Product amounts, discount summaries, and payments must reconcile; damaged receipts enter Review. The supplied PDF reconciles eight products and one discount to €11.95. Maxima is available in upload, filter, and manual review selectors, and unique Maxima bank payments use the standard receipt matching rules.

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

Amounts are integer currency minor units, including zero- and three-decimal currencies. EUR, USD, GBP, and other currencies have separate views; there is no invented exchange conversion. Choose currency and month in the app. The timezone is Europe/Tallinn. Dates are displayed and entered as `YYYY-MM-DD`, months as `YYYY-MM`, and timestamps as `YYYY-MM-DD HH:mm` in 24-hour Tallinn time.

Expense totals include booked bank and recorded cash purchases, with refunds subtracted. Pending transactions, own-account transfers, and ATM withdrawals do not count as spending. A withdrawal remains unallocated cash until actual cash purchases are recorded. Own-account transfer detection uses known account IBANs; inspect older payments after connecting additional banks and correct ambiguous types. Incoming payments without a refund marker initially classify as income; use the payment editor to correct unmarked refunds.

Manual transaction categories take precedence. Automatic entries use your merchant/description rules, validated receipt product splits, then merchant/MCC fallback. Product mappings and product rules improve receipt categories. Create prioritized rules, preview matches, and choose whether to apply them to existing automatic entries. Corrections are audited and are retained across reimports. Merchant/MCC/product inference is transparent and deliberately leaves unknown cases uncategorized.

Overview focuses on one calendar month: remaining spending allowance, actual surplus before and after contributions, estimated month-end spending, goal progress, categories needing attention, unpaid commitments, a cash check before payday, and a compact six-month surplus trend. Its data alerts cover uncategorized spending, pending payments, unallocated cash, and stale bank syncs. Receipt coverage is on Receipts; the complete transaction list is on Transactions.

**Goals** contains the spending plan for the selected month and currency. Enter total expected take-home income, an optional living-expense cap, a cash buffer, monthly and annual investment/pension targets, category limits, bills, and optionally a booked cash balance and next payday. Annual targets are shared across months of the selected year. Copying the previous month keeps its income, limits, targets, and bills, resets bill statuses to unpaid, and clears cash balance and payday; review and save the copy before it affects Overview. Plans are stored in the database and included in backups.

The remaining allowance uses expected income (or received income when no expectation is entered), minus living expenses, pending expenses, unpaid bills, the larger of actual net contributions and required goal contributions, and the buffer. An explicit spending cap can lower this allowance. Without income, a configured cap shows budget headroom only. Annual catch-up targets divide the amount still needed at the start of the selected month across the remaining months of the year. Withdrawals reduce goal progress. Contributions remain separate from living expenses.

Month-end forecasts start after three days of the current month and extrapolate recorded variable spending. Fixed categories and bills marked booked are excluded from that daily pace; unpaid bills and pending expenses are added once. For a matching payment already imported, change its bill status to Pending or Booked: the checklist does not create payments or automatically match them. Forecast accuracy depends on recording bills and maintaining those statuses. Completed months use received income and actual spending, without today's pending payments or an extrapolated pace. Future months show the plan without a spending forecast. Earlier spending comparisons use the same elapsed days for the current month and only earlier months with imported activity.

The optional cash check uses the manually entered booked balance before pending payments, deducts external outgoing pending payments (excluding own-account transfers and cash movements), unpaid bills due before the entered payday, and the buffer. Without a payday, or once the recorded payday has passed, it includes all unpaid bills in the selected month. It does not assume future income has arrived or assign contribution due dates. Refresh the balance as money moves; its entry timestamp is shown. This liquidity check is separate from the allowance based on this month's income.

**Spending analysis** has the detailed income/spending and cumulative net cash flow chart, categories, merchants, and category trends. Select one to twelve months ending in the chosen month; the period is remembered and included in analysis URLs. Old six-month links redirect here with six months selected. Its cumulative graph starts at the beginning of the selected period and includes spending, refunds, and net investment and pension contributions.

Authenticated planning endpoints: `GET /api/financial-overview?month=YYYY-MM&currency=EUR`, `GET /api/spending-plan?month=YYYY-MM&currency=EUR`, and `POST /api/spending-plan` with `{month, currency, plan}`. Plan amounts are integer minor units of the selected currency; validation rejects negative targets, duplicate category limits, nonexistent categories, invalid dates, and contribution categories used as living-expense limits.

Transactions support search and filters for account, category, type, receipt presence, amount, and status. Select individual expenses or refunds, or all payments on the current page, to bulk mark receipts required or not required. In a transaction’s Receipts panel, preview and update similar payments across all history by merchant, payment type, currency, and an optional description pattern. Similar updates skip receipt-linked payments and preserve categories, amounts, and notes. Settings exports expenses, category allocations, and receipt products as CSV, with spreadsheet formula escaping.

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

The web app and worker can run as local Node processes or in the published container; Compose manages PostgreSQL. This adapts the original [implementation plan](PLAN.md) to local hosting. PWA offline caching, additional retailer account synchronization, currency conversion and model-based suggestions are later extensions.
