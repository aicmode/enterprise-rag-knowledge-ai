import { describe, expect, it } from 'vitest';

import {
  EMBEDDING_DIMENSIONS,
  RAG_DEFAULTS,
  resolveRagConfig,
} from '@/lib/config/rag';
import { batchItems } from '@/lib/rag/embedding';

describe('resolveRagConfig', () => {
  it('falls back to defaults when nothing is set', () => {
    expect(resolveRagConfig({})).toEqual(RAG_DEFAULTS);
  });

  it('reads valid values from the environment', () => {
    const config = resolveRagConfig({
      RAG_CHUNK_SIZE: '800',
      RAG_CHUNK_OVERLAP: '100',
      RAG_TOP_K: '8',
      RAG_SIMILARITY_THRESHOLD: '0.45',
      OPENAI_CHAT_MODEL: 'gpt-4o',
      OPENAI_OCR_MODEL: 'gpt-5-mini',
    });

    expect(config).toEqual({
      chunkSize: 800,
      chunkOverlap: 100,
      topK: 8,
      similarityThreshold: 0.45,
      chatModel: 'gpt-4o',
      ocrModel: 'gpt-5-mini',
    });
  });

  it('ignores unparseable values rather than crashing', () => {
    const config = resolveRagConfig({
      RAG_CHUNK_SIZE: 'not-a-number',
      RAG_TOP_K: '',
      RAG_SIMILARITY_THRESHOLD: 'abc',
    });

    expect(config.chunkSize).toBe(RAG_DEFAULTS.chunkSize);
    expect(config.topK).toBe(RAG_DEFAULTS.topK);
    expect(config.similarityThreshold).toBe(RAG_DEFAULTS.similarityThreshold);
  });

  it('clamps the overlap to at most half the chunk size', () => {
    // An overlap >= chunk size would stop the chunker from advancing.
    const config = resolveRagConfig({ RAG_CHUNK_SIZE: '1000', RAG_CHUNK_OVERLAP: '5000' });

    expect(config.chunkOverlap).toBe(500);
    expect(config.chunkOverlap).toBeLessThan(config.chunkSize);
  });

  it('clamps the similarity threshold into 0..1', () => {
    expect(resolveRagConfig({ RAG_SIMILARITY_THRESHOLD: '5' }).similarityThreshold).toBe(1);
    expect(resolveRagConfig({ RAG_SIMILARITY_THRESHOLD: '-2' }).similarityThreshold).toBe(0);
  });

  it('clamps topK into a sane range', () => {
    expect(resolveRagConfig({ RAG_TOP_K: '0' }).topK).toBe(1);
    expect(resolveRagConfig({ RAG_TOP_K: '9999' }).topK).toBe(20);
  });

  it('clamps chunk size into a workable range', () => {
    expect(resolveRagConfig({ RAG_CHUNK_SIZE: '10' }).chunkSize).toBe(200);
    expect(resolveRagConfig({ RAG_CHUNK_SIZE: '999999' }).chunkSize).toBe(4000);
  });

  it('treats a blank chat model as unset', () => {
    expect(resolveRagConfig({ OPENAI_CHAT_MODEL: '   ' }).chatModel).toBe(RAG_DEFAULTS.chatModel);
  });

  it('keeps answer and OCR models independently configurable', () => {
    const config = resolveRagConfig({
      OPENAI_CHAT_MODEL: 'gpt-5-mini',
      OPENAI_OCR_MODEL: 'gpt-5-nano',
    });

    expect(config.chatModel).toBe('gpt-5-mini');
    expect(config.ocrModel).toBe('gpt-5-nano');
  });

  it('never produces a negative overlap', () => {
    expect(resolveRagConfig({ RAG_CHUNK_OVERLAP: '-100' }).chunkOverlap).toBe(0);
  });
});

describe('EMBEDDING_DIMENSIONS', () => {
  it('matches the vector(1536) column in the migration', () => {
    // If this ever changes, supabase/migrations must change with it -- the
    // constant and the DDL are two halves of one decision.
    expect(EMBEDDING_DIMENSIONS).toBe(1536);
  });
});

describe('batchItems', () => {
  it('returns no batches for an empty list', () => {
    expect(batchItems([], 10)).toEqual([]);
  });

  it('splits into fixed-size batches', () => {
    expect(batchItems([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('keeps a list smaller than the batch size in one batch', () => {
    expect(batchItems([1, 2], 10)).toEqual([[1, 2]]);
  });

  it('preserves order and loses no items', () => {
    const items = Array.from({ length: 205 }, (_, i) => i);
    const batches = batchItems(items, 64);

    expect(batches).toHaveLength(4);
    expect(batches.flat()).toEqual(items);
  });

  it('rejects a batch size below 1 instead of looping forever', () => {
    expect(() => batchItems([1, 2, 3], 0)).toThrow();
  });
});
