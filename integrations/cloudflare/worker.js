// Inbound receipt email bridge. Deploy only after configuring the KV namespace
// and INBOUND_EMAIL_TOKEN secret. No bank credentials belong in this Worker.
const MAX_BYTES = 20 * 1024 * 1024;
async function deliver(env, key, raw) {
  const response = await fetch(`${env.APP_URL}/api/inbound/email`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.INBOUND_EMAIL_TOKEN}`,
      "Content-Type": "message/rfc822",
    },
    body: raw,
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw new Error(`Receipt receiver returned HTTP ${response.status}`);
  await env.EMAIL_INBOX.delete(key);
}
export default {
  async email(message, env) {
    if (message.rawSize > MAX_BYTES) {
      message.setReject("Receipt email exceeds the 20 MB limit.");
      return;
    }
    const raw = await new Response(message.raw).arrayBuffer();
    const key = `email:${new Date().toISOString()}:${crypto.randomUUID()}`;
    // Persist before delivery. A sleeping/offline local machine will be retried
    // by the scheduled handler. KV retains undelivered messages for seven days.
    await env.EMAIL_INBOX.put(key, raw, { expirationTtl: 7 * 86400 });
    try {
      await deliver(env, key, raw);
    } catch {
      console.warn(
        "Receipt stored for retry; local app is currently unavailable.",
      );
    }
  },
  async scheduled(controller, env) {
    const batch = await env.EMAIL_INBOX.list({ prefix: "email:", limit: 10 });
    for (const item of batch.keys) {
      const raw = await env.EMAIL_INBOX.get(item.name, "arrayBuffer");
      if (!raw) continue;
      try {
        await deliver(env, item.name, raw);
      } catch {
        console.warn("Receipt delivery postponed.");
        break;
      }
    }
  },
};
