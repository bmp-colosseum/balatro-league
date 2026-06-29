import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // In the npm workspace, `next` + the @balatro/* packages are hoisted to the
  // MONOREPO root node_modules, so turbopack's root must be the repo root (not
  // this app dir) for resolution + transpilePackages to work.
  turbopack: {
    root: path.resolve(__dirname, "..", ".."),
  },
  // The shared domain packages ship TypeScript source (internal-packages
  // pattern), so Next must transpile them.
  transpilePackages: ["@balatro/competition-core", "@balatro/tour-core", "@balatro/match-core"],
  // The admin "import history" upload (a ~30MB zip of the sheets) goes through a
  // server action; raise the default 1MB body cap for it.
  experimental: {
    serverActions: { bodySizeLimit: "64mb" },
  },
};

export default nextConfig;
