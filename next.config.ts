import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /**
   * Keep sql.js out of the server bundle.
   *
   * sql.js ships an emscripten/UMD wrapper. When webpack bundles it for the
   * server build, that wrapper's `module.exports` assignment is rewritten and
   * loading it throws `TypeError: Cannot set properties of undefined (setting
   * 'exports')`. The failure is invisible in development because `next dev`
   * runs Turbopack, but every server-rendered database-backed route — /accounts,
   * /budgets, /recurring, /reports — returned HTTP 500 under `next start` and in
   * the Docker image, which runs the same webpack server bundle via
   * `node server.js`.
   *
   * Marking it external makes the server `require()` it from node_modules at
   * runtime instead, which is also why the Dockerfile copies node_modules/sql.js
   * into the runner stage.
   */
  serverExternalPackages: ["sql.js"],
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
