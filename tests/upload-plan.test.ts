import { describe, expect, it } from 'vitest';

import { MAX_FILE_SIZE_BYTES, MAX_UPLOAD_PARTS, UPLOAD_PART_SIZE_BYTES } from '@/lib/config/rag';
import { planUploadParts } from '@/lib/upload';

/**
 * Upload slicing.
 *
 * The whole reason this exists is the 4.5 MB Vercel request-body cap against a
 * 10 MB file limit, so the properties worth asserting are: no part can exceed
 * the cap, the parts reassemble into exactly the original file, and the part
 * count stays inside what the server will accept.
 */
describe('planUploadParts', () => {
  it('keeps every part safely under the serverless body limit', () => {
    const VERCEL_BODY_LIMIT = 4.5 * 1024 * 1024;

    expect(UPLOAD_PART_SIZE_BYTES).toBeLessThan(VERCEL_BODY_LIMIT);

    for (const part of planUploadParts(MAX_FILE_SIZE_BYTES)) {
      expect(part.end - part.start).toBeLessThanOrEqual(UPLOAD_PART_SIZE_BYTES);
    }
  });

  it('covers the file exactly once, with no gap and no overlap', () => {
    const size = MAX_FILE_SIZE_BYTES - 12_345;
    const parts = planUploadParts(size);

    expect(parts[0].start).toBe(0);
    expect(parts.at(-1)?.end).toBe(size);

    for (const [index, part] of parts.entries()) {
      expect(part.index).toBe(index);
      if (index > 0) expect(part.start).toBe(parts[index - 1].end);
    }

    const covered = parts.reduce((sum, part) => sum + (part.end - part.start), 0);
    expect(covered).toBe(size);
  });

  it('never needs more parts than the server accepts', () => {
    expect(planUploadParts(MAX_FILE_SIZE_BYTES).length).toBeLessThanOrEqual(MAX_UPLOAD_PARTS);
  });

  it('sends a small file as a single part', () => {
    expect(planUploadParts(1024)).toEqual([{ index: 0, start: 0, end: 1024 }]);
  });

  it('returns nothing for an empty file', () => {
    expect(planUploadParts(0)).toEqual([]);
  });

  it('does not emit a trailing empty part when the size divides exactly', () => {
    const parts = planUploadParts(UPLOAD_PART_SIZE_BYTES * 2);

    expect(parts).toHaveLength(2);
    expect(parts.every((part) => part.end > part.start)).toBe(true);
  });
});
