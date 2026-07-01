import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lock turbopack's root to this folder; the repo root has a lockfile from the
  // Discord bot which would otherwise be picked up by mistake.
  turbopack: {
    root: path.resolve(__dirname),
  },
  // The old "arrange" build step was merged into the preview page; keep any
  // historical/bookmarked links working instead of 404-ing.
  async redirects() {
    return [
      {
        source: "/admin/signups/:id/arrange",
        destination: "/admin/signups/:id/preview",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
