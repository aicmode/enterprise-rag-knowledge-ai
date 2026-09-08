import { describe, expect, it } from 'vitest';

import { joinTextItems, normalizePageText } from '@/lib/rag/pdf';

describe('joinTextItems', () => {
  it('returns an empty string for no items', () => {
    expect(joinTextItems([])).toBe('');
  });

  it('inserts a space between adjacent Latin runs', () => {
    // pdf.js emits positioned fragments; joining naively yields "annualpaid".
    expect(joinTextItems([{ str: 'annual' }, { str: 'paid' }, { str: 'leave' }])).toBe(
      'annual paid leave',
    );
  });

  it('does not insert spaces between Japanese characters', () => {
    expect(joinTextItems([{ str: '年次有給' }, { str: '休暇' }])).toBe('年次有給休暇');
  });

  it('does not double up when a fragment already ends with a space', () => {
    expect(joinTextItems([{ str: 'annual ' }, { str: 'leave' }])).toBe('annual leave');
  });

  it('turns hasEOL into a newline', () => {
    expect(joinTextItems([{ str: 'first', hasEOL: true }, { str: 'second' }])).toBe(
      'first\nsecond',
    );
  });

  it('skips items with no string content', () => {
    expect(joinTextItems([{ str: 'a' }, {}, { str: 'b' }])).toBe('a b');
  });
});

describe('normalizePageText', () => {
  it('collapses runs of spaces', () => {
    expect(normalizePageText('a     b')).toBe('a b');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizePageText('   text   ')).toBe('text');
  });

  it('normalises CRLF line endings', () => {
    expect(normalizePageText('a\r\nb')).toBe('a\nb');
  });

  it('collapses excessive blank lines but keeps paragraph breaks', () => {
    expect(normalizePageText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('removes zero-width and soft-hyphen characters', () => {
    // These are invisible but would otherwise become part of the embedded text
    // and of the excerpt shown in a citation.
    const raw = 'ab​c­d﻿e';

    expect(normalizePageText(raw)).toBe('abcde');
  });

  it('collapses full-width spaces used for indentation', () => {
    expect(normalizePageText('第1条　　目的')).toBe('第1条 目的');
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(normalizePageText('  \n\n 　 ')).toBe('');
  });
});
