/**
 * Storage bucket name, shared by client and server.
 *
 * Kept in its own module because `ingest.ts` is `server-only`; importing the
 * constant from there into the browser upload helper would drag the whole
 * server pipeline into the client bundle.
 */
export const DOCUMENTS_BUCKET = 'documents';
