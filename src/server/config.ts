import dotenv from "dotenv";
import path from "node:path";
dotenv.config({ path: ".env.local", quiet: true });
export const config = {
  port: Number(process.env.PORT || 4317),
  host: process.env.HOST || "127.0.0.1",
  appUrl: process.env.APP_URL || "http://127.0.0.1:4317",
  accessUrl:
    process.env.ACCESS_URL || `http://127.0.0.1:${process.env.PORT || 4317}`,
  trustProxy: process.env.TRUST_PROXY === "true",
  databaseUrl: process.env.DATABASE_URL || "",
  encryptionKey: process.env.ENCRYPTION_KEY || "",
  setupToken: process.env.OWNER_SETUP_TOKEN || "",
  inboundToken: process.env.INBOUND_EMAIL_TOKEN || "",
  bankingId: process.env.ENABLE_BANKING_APP_ID || "",
  bankingKeyPath: process.env.ENABLE_BANKING_PRIVATE_KEY_PATH || "",
  bankingRedirect:
    process.env.ENABLE_BANKING_REDIRECT_URL ||
    `${process.env.APP_URL || "http://127.0.0.1:4317"}/callback`,
  dataDir: path.resolve(
    /* turbopackIgnore: true */ process.env.DATA_DIR || ".data",
  ),
};
export function assertConfig() {
  for (const value of [config.appUrl, config.accessUrl]) {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error(
        "APP_URL and ACCESS_URL must be HTTP(S) origins without a path, credentials, or query.",
      );
  }
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
  if (!/^[a-f\d]{64}$/i.test(config.encryptionKey))
    throw new Error("ENCRYPTION_KEY must contain 64 hexadecimal characters");
  if (config.setupToken.length < 24 || config.inboundToken.length < 24)
    throw new Error("Configure random owner setup and inbound email tokens");
}
