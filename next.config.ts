import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /**
   * pdfjs-dist must stay outside the bundler.
   *
   * The legacy build resolves its own worker and font resources at runtime and
   * relies on Node built-ins; bundling it produces a parser that fails at
   * runtime in a serverless function. Marking it external means the real
   * package is loaded from node_modules instead.
   */
  serverExternalPackages: ['pdfjs-dist'],

  // Note: Next 16 no longer runs ESLint as part of `next build`, and the
  // `eslint` config block was removed with it. Linting is its own step
  // (`npm run lint`) and is expected to run in CI alongside the build.

  // Next 16 writes AGENTS.md / CLAUDE.md into the repo root on every build.
  // Turned off so the tracked file set stays exactly what this project owns.
  agentRules: false,

  typescript: {
    // Never ship a build with type errors.
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
