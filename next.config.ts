import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
const config: NextConfig = {
  // The development badge otherwise covers the mobile Overview tab.
  devIndicators: false,
  serverExternalPackages: [
    "playwright",
    "playwright-core",
    "pg",
    "pg-boss",
    "mailparser",
    "pdfjs-dist",
    "@napi-rs/canvas",
    "tesseract.js",
  ],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Cache-Control", value: "private, no-store" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};
export default function nextConfig(phase: string): NextConfig {
  return {
    ...config,
    // Development must not overwrite the build used by the running app.
    distDir:
      process.env.NEXT_DIST_DIR ||
      (phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next"),
  };
}
