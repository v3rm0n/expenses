# Personal expenses

A private, single-owner web app for tracking bank transactions and itemized receipts. It runs on your own machine, with a responsive interface for phones and computers.

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

Install dependencies with `npm ci`, copy `.env.example` to `.env.local`, and configure the secrets described in the [setup guide](GUIDE.md#getting-started). Then run `npm run build` and `npm start`, and use `npm run setup` in a second terminal to create the owner account.

The app defaults to `http://127.0.0.1:4317`. The local runner starts the web app, background worker, and PostgreSQL database. Use `npm run dev` for development.

## Project

Built with Next.js, React, TypeScript, and PostgreSQL. The interface lives in `src/app` and `src/components`, backend services in `src/server`, and currency math, classification, and receipt parsers in `src/lib`.

See the [application guide](GUIDE.md) for hosting, integrations, supported receipt formats, reporting behavior, backups, and development checks. The [Cloudflare email bridge](integrations/cloudflare/README.md) has its own deployment instructions, and [PLAN.md](PLAN.md) records the original implementation plan.
