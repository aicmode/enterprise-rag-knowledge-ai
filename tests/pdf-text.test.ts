import { describe, expect, it } from 'vitest';

import { evaluatePageText, joinTextItems, normalizePageText } from '@/lib/rag/pdf';

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

describe('evaluatePageText', () => {
  it('reports page-level counts after normalization', () => {
    const result = evaluatePageText('従業員 は週に最大3日までリモート勤務を利用できます。');

    expect(result.quality.characterCount).toBe(Array.from(result.text).length);
    expect(result.quality.nonWhitespaceCharacterCount).toBe(
      Array.from(result.text).filter((char) => !/\s/u.test(char)).length,
    );
    expect(result.quality.usable).toBe(true);
  });

  it('marks replacement and private-use glyphs as garbled', () => {
    const result = evaluatePageText('正常な文字列です'.padEnd(20, '\ufffd'));

    expect(result.quality.garbledRatio).toBeGreaterThan(0.2);
    expect(result.quality.usable).toBe(false);
  });

  it('keeps full-width Japanese content intact', () => {
    expect(normalizePageText('ＡＢＣ　１２３　日本語')).toBe('ＡＢＣ １２３ 日本語');
  });
});
