import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* The Electron build (scripts/build-electron.mjs) needs a self-contained
     server; the web build stays a plain `next build`. */
  ...(process.env.OHF_STANDALONE === "1" ? { output: "standalone" as const } : {}),
};

export default nextConfig;
