import type { NextConfig } from "next";
import path from "path";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  basePath,
  assetPrefix: basePath,
  // This app is its own root. Without this, Next picks up an unrelated
  // package-lock.json in the home directory and warns on every build.
  outputFileTracingRoot: path.join(__dirname),
  // No output: "standalone". pm2 runs `next start`, which doesn't support that
  // output and warned about it on every restart; nothing used the standalone build.
};

export default nextConfig;
