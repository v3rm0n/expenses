# Forward receipt email to the local app

This bridge uses Cloudflare Email Routing, an Email Worker, and Workers KV. It accepts raw MIME, persists it first, then delivers to the authenticated API. Retry runs every 15 minutes. Undelivered originals expire after **seven days**; the local app must come online within that window. Neither a bank signing key nor Enable Banking credentials belong in this Worker.

1. Finish the reverse proxy so `https://expenses.example.com/api/health` returns `{"ok":true}`.
2. In Cloudflare’s dashboard, enable Email Routing for a dedicated **receipts.example.com** subdomain. Keep existing mail MX records on the root `example.com` domain. Follow the [subdomain configuration guide](https://developers.cloudflare.com/email-service/configuration/subdomains/).
3. Sign in locally or over HTTPS, then open **Settings → Receipt email bridge → Reveal bridge token**. Copy it; this is independent of your bank credentials.
4. From the repository root, copy the deployment template, set `APP_URL` in the local `wrangler.jsonc` to your public app origin, then create the KV namespace and replace `REPLACE_WITH_KV_NAMESPACE_ID` in `wrangler.jsonc` with the returned ID:

   ```sh
   cd integrations/cloudflare
   cp wrangler.example.jsonc wrangler.jsonc
   npx wrangler login
   npx wrangler kv namespace create EMAIL_INBOX
   ```

5. Store the copied token at the interactive prompt, then deploy:

   ```sh
   npx wrangler secret put INBOUND_EMAIL_TOKEN
   npx wrangler deploy
   ```

6. In Email Routing, create a custom-address rule for **receipts@receipts.example.com**, with the action **Send to a Worker**, selecting `expenses-receipts`. Finish any dashboard verification steps. Send a test receipt email, then check **Settings → Received email** and **Receipts** in the app.

`wrangler.jsonc` and Wrangler’s local state are ignored by Git; the checked-in example contains no installation-specific namespace ID. Keep `INBOUND_EMAIL_TOKEN` in Wrangler secrets.

The worker has no public HTTP email endpoint. It receives mail through the routing rule. The local API accepts authenticated POSTs with `Content-Type: message/rfc822`; it durably stores the message and queues processing before acknowledging delivery. Retries have the same raw-message hash, so repeated deliveries do not create extra receipts.

Inbound messages are limited to 20 MB, below KV’s per-value maximum. KV and Email Worker free quotas apply; this is intended for personal receipt volume. Monitor the pending `email:` keys and worker errors in Cloudflare while bringing the setup online. An unavailable receiver results in a retry log without logging message contents or the token. A full KV namespace or quota exhaustion can prevent buffering new mail. For a machine offline beyond seven days, increase retention or choose an always-on receiver.

Email Routing is currently free for inbound mail; Workers/KV are limited by their free tiers. See [Email pricing](https://developers.cloudflare.com/email-service/platform/pricing/), [KV quotas](https://developers.cloudflare.com/kv/platform/pricing/), and the [Email handler API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/). This receives forwarded messages without operating an SMTP server or a mailbox API.

For Gmail forwarding, first add the custom receipt address in Gmail’s forwarding settings. Its confirmation message is delivered through the same Worker. Open **Settings → Received email → Open message** in the app, copy the confirmation code or open the Gmail confirmation link, then finish the forwarding setup in Gmail. The app retains verification messages separately from receipts.

Only mail containing an actual receipt attachment or receipt body can be parsed as a receipt. Retailer sign-in links remain for manual export/review.
