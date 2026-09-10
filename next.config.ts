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
  serverExternalPackages: ['pdfjs-dist', '@napi-rs/canvas'],

  /**
   * PDF.js reaches for these at runtime rather than through a static import, so
   * the serverless file tracer cannot see them and needs an explicit include.
   *
   * The worker is the one that broke Preview: pdf.js loads it through a
   * computed specifier, which no static analysis can follow, so it was left out
   * of the function bundle and parsing died with "Setting up fake worker
   * failed". `src/lib/rag/pdf.ts` now imports it under a literal specifier as
   * well; this include is what guarantees the file is there either way.
   */
  outputFileTracingIncludes: {
    '/api/documents/process': [
      './node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
      './node_modules/pdfjs-dist/cmaps/**/*',
      './node_modules/pdfjs-dist/standard_fonts/**/*',
      './node_modules/pdfjs-dist/wasm/**/*',
    ],
  },

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
