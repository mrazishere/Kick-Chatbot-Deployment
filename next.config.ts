import type { NextConfig } from "next";
import fs from "fs";
import path from "path";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// Builds alternate between two directories (scripts/deploy.sh), so the live
// server keeps serving its own build while the next one compiles. The build
// sets DASH_DIST_DIR; `next start` follows .next-live, which names the build to run.
function distDir(): string {
  if (process.env.DASH_DIST_DIR) return process.env.DASH_DIST_DIR;
  try {
    const live = fs.readFileSync(path.join(__dirname, ".next-live"), "utf8").trim();
    if (/^\.next-[ab]$/.test(live)) return live;
  } catch {
    // no deploy has run yet
  }
  return ".next";
}

const nextConfig: NextConfig = {
  basePath,
  assetPrefix: basePath,
  distDir: distDir(),
  // Baked into both the overlay pages and the feed they poll: a page whose id
  // differs from the feed's is running an old build, and reloads itself.
  env: { DASH_BUILD_ID: process.env.DASH_BUILD_ID ?? "" },
  // This app is its own root. Without this, Next picks up an unrelated
  // package-lock.json in the home directory and warns on every build.
  outputFileTracingRoot: path.join(__dirname),
  // No output: "standalone". pm2 runs `next start`, which doesn't support that
  // output and warned about it on every restart; nothing used the standalone build.
};

export default nextConfig;
