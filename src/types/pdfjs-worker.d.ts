/**
 * `pdfjs-dist` ships type declarations for `legacy/build/pdf.mjs` only; the
 * worker entry point has none. It is imported for one reason -- to hand pdf.js
 * its `WorkerMessageHandler` through `globalThis.pdfjsWorker` so no worker path
 * is resolved at runtime (see `src/lib/rag/pdf.ts`) -- so the handler is typed
 * as `unknown`: nothing in this codebase calls into it directly.
 */
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
