import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { assertConfig, config, randomToken } from "../../src/server/config";
import {
  hashPassword,
  passwordNeedsRehash,
  verifyPassword,
} from "../../src/server/crypto";
import { clientIp } from "../../src/server/auth";

const generated = () => randomBytes(32).toString("hex");

describe("configured secrets", () => {
  it("rejects the .env.example placeholders and weak tokens", () => {
    expect(randomToken("replace-with-a-random-token")).toBe(false);
    expect(randomToken("replace-with-another-random-token")).toBe(false);
    expect(randomToken("a".repeat(40))).toBe(false);
    expect(randomToken("short-but-random-9f2")).toBe(false);
    expect(randomToken(generated())).toBe(true);
    expect(randomToken("expenses-test-setup-token-only")).toBe(true);
  });
  it("requires independent setup and inbound email tokens", () => {
    const saved = { ...config };
    try {
      Object.assign(config, {
        appUrl: "http://127.0.0.1:4317",
        accessUrl: "http://127.0.0.1:4317",
        databaseUrl: "postgresql://localhost/expenses",
        encryptionKey: generated(),
        setupToken: generated(),
        inboundToken: generated(),
      });
      expect(() => assertConfig()).not.toThrow();
      config.inboundToken = "replace-with-another-random-token";
      expect(() => assertConfig()).toThrow(/placeholders/);
      config.inboundToken = config.setupToken;
      expect(() => assertConfig()).toThrow(/different/);
    } finally {
      Object.assign(config, saved);
    }
  });
});

describe("password hashes", () => {
  it("stores scrypt parameters and verifies new hashes", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^scrypt\$131072\$8\$1\$[a-f\d]{32}\$[a-f\d]{128}$/);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong horse battery", hash)).toBe(false);
    expect(passwordNeedsRehash(hash)).toBe(false);
  });
  it("verifies legacy hashes made with Node's default cost and asks for a rehash", async () => {
    const { scryptSync } = await import("node:crypto");
    const salt = "0123456789abcdef0123456789abcdef";
    const legacy = `${salt}:${scryptSync("old password!", salt, 64).toString("hex")}`;
    expect(await verifyPassword("old password!", legacy)).toBe(true);
    expect(await verifyPassword("other password", legacy)).toBe(false);
    expect(passwordNeedsRehash(legacy)).toBe(true);
    expect(await verifyPassword("anything", "garbage")).toBe(false);
  });
});

describe("client addresses behind a proxy", () => {
  const request = (forwarded?: string) =>
    new NextRequest("http://127.0.0.1:4317/api/auth/login", {
      headers: forwarded ? { "X-Forwarded-For": forwarded } : {},
    });
  it("uses the address added by the trusted proxy, not one the client sent", () => {
    const trust = config.trustProxy;
    try {
      config.trustProxy = true;
      expect(clientIp(request("203.0.113.9"))).toBe("203.0.113.9");
      expect(clientIp(request("198.51.100.1, 203.0.113.9"))).toBe(
        "203.0.113.9",
      );
      expect(clientIp(request())).toBe("local");
      config.trustProxy = false;
      expect(clientIp(request("203.0.113.9"))).toBe("local");
    } finally {
      config.trustProxy = trust;
    }
  });
});
