# Personal expenses

A self-hosted, single-owner web app for tracking bank transactions and itemized receipts. It runs on your own machine, with a responsive interface for phones and computers.

## Features

- Bank connections through Enable Banking, with scheduled imports and manual refresh.
- Receipt uploads, local OCR, review, and matching to bank payments; Amazon.de invoice packs, Lidl Plus imports, and forwarded email ingestion.
- Transaction search, cash entries, classification rules, and product categories.
- Double-entry journals, account balances, and editable opening balances, with database-enforced balancing.
- Advanced bookkeeping with manual split journals, a general ledger, trial balance, chart of accounts, income statement, and balance sheet.
- Monthly spending plans, remaining allowances, spending forecasts, bill checklists, and investment/pension goals, with each currency tracked separately.
- Detailed spending, income, cash flow, merchant, and contribution history analysis.
- CSV exports and encrypted backups of the database and original documents.

## Running locally

Requires Node.js 22.13 or newer, npm, and Docker (or Colima on macOS).

Install dependencies and create your local configuration:

```sh
npm ci
cp .env.example .env.local
```

Configure database credentials and generate independent random secrets as described in the [setup guide](GUIDE.md#getting-started). Then build and start the app:

```sh
npm run build
npm start
```

In a second terminal, run `npm run setup` and open the printed setup link to create the owner account. Banking and retailer integrations are optional and require your own accounts and credentials.

The app defaults to `http://127.0.0.1:4317`. The local runner starts the web app, background worker, and PostgreSQL database. Use `npm run dev` for development.

## Container image

Every push to `main` builds and publishes `ghcr.io/v3rm0n/expenses:latest` and a `sha-<full-commit-sha>` tag for Linux AMD64 and ARM64. The image includes the web app, background worker, and Chromium for receipt imports. Configuration and private data are supplied at runtime.

See [running with Docker](GUIDE.md#running-with-docker) for deployment and local builds.

## Project

Built with Next.js, React, TypeScript, and PostgreSQL. The interface lives in `src/app` and `src/components`, backend services in `src/server`, and currency math, classification, and receipt parsers in `src/lib`.

See the [application guide](GUIDE.md) for hosting, integrations, supported receipt formats, reporting behavior, backups, and development checks. The [Cloudflare email bridge](integrations/cloudflare/README.md) has its own deployment instructions, and [PLAN.md](PLAN.md) records the original implementation plan.

## Development

```sh
npm test
npm run typecheck
npm run format:check
```

See the [guide’s checks section](GUIDE.md#checks) for database integration and browser tests.

## Private data

Keep credentials in `.env.local` and signing keys outside the repository. Local configuration, `.data/`, backups, and the Cloudflare deployment configuration are ignored by Git. Use synthetic or anonymized test fixtures; do not commit personal receipts, bank exports, or account identifiers.

## License

[MIT](LICENSE).
