/**
 * Minimal PDF writer used only by tests.
 *
 * Building the fixture in-process (rather than committing a binary) keeps the
 * expected page->text mapping visible in the test itself, which is the whole
 * point of the extraction test: we assert that page 3's text really is reported
 * as page 3.
 */
export function buildTestPdf(pageTexts: readonly string[]): Uint8Array {
  const objects: string[] = [];
  const pageCount = pageTexts.length;
  const fontId = 3 + pageCount * 2;

  const kids = Array.from({ length: pageCount }, (_, i) => `${3 + i} 0 R`).join(' ');

  objects[1] = '<</Type/Catalog/Pages 2 0 R>>';
  objects[2] = `<</Type/Pages/Kids[${kids}]/Count ${pageCount}>>`;

  for (let i = 0; i < pageCount; i += 1) {
    const contentId = 3 + pageCount + i;
    objects[3 + i] =
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]` +
      `/Contents ${contentId} 0 R/Resources<</Font<</F1 ${fontId} 0 R>>>>>>`;
  }

  for (let i = 0; i < pageCount; i += 1) {
    const escaped = pageTexts[i].replace(/([()\\])/g, '\\$1');
    const stream = `BT /F1 14 Tf 72 700 Td (${escaped}) Tj ET`;
    objects[3 + pageCount + i] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
  }

  objects[fontId] = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>';

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];

  for (let i = 1; i <= fontId; i += 1) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefPosition = out.length;
  out += `xref\n0 ${fontId + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= fontId; i += 1) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<</Size ${fontId + 1}/Root 1 0 R>>\nstartxref\n${xrefPosition}\n%%EOF\n`;

  return Uint8Array.from(out, (char) => char.charCodeAt(0) & 0xff);
}

type PdfObject = string | Buffer;

function assemblePdf(objects: ReadonlyMap<number, PdfObject>, trailerExtra = ''): Uint8Array {
  const maxId = Math.max(...objects.keys());
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'binary')];
  const offsets: number[] = [];
  let length = parts[0].length;

  for (let id = 1; id <= maxId; id += 1) {
    const object = objects.get(id);
    if (object === undefined) throw new Error(`Missing PDF object ${id}`);
    offsets[id] = length;
    const header = Buffer.from(`${id} 0 obj\n`, 'binary');
    const body = typeof object === 'string' ? Buffer.from(object, 'binary') : object;
    const footer = Buffer.from('\nendobj\n', 'binary');
    parts.push(header, body, footer);
    length += header.length + body.length + footer.length;
  }

  const xrefPosition = length;
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id += 1) {
    xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<</Size ${maxId + 1}/Root 1 0 R${trailerExtra}>>\nstartxref\n${xrefPosition}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'binary'));

  return new Uint8Array(Buffer.concat(parts));
}

function streamObject(dictionary: string, stream: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`<<${dictionary}/Length ${stream.length}>>\nstream\n`, 'binary'),
    stream,
    Buffer.from('\nendstream', 'binary'),
  ]);
}

function utf16BeHex(text: string): string {
  return Array.from(text)
    .map((char) => {
      const codePoint = char.codePointAt(0);
      if (codePoint === undefined || codePoint > 0xffff) {
        throw new Error('Test fixture supports BMP characters only');
      }
      return codePoint.toString(16).padStart(4, '0');
    })
    .join('');
}

/** Japanese text-layer PDF using an Identity-H CID font and embedded ToUnicode CMap. */
export function buildJapaneseTextPdf(text: string): Uint8Array {
  const characters = Array.from(new Set(Array.from(text)));
  const mappings = characters
    .map((char) => {
      const hex = utf16BeHex(char);
      return `<${hex}> <${hex}>`;
    })
    .join('\n');
  const toUnicode = Buffer.from(
    `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n` +
      `/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n` +
      `/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n` +
      `1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n` +
      `${characters.length} beginbfchar\n${mappings}\nendbfchar\n` +
      `endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`,
    'binary',
  );
  const content = Buffer.from(`BT /F1 14 Tf 72 700 Td <${utf16BeHex(text)}> Tj ET`, 'binary');
  const objects = new Map<number, PdfObject>([
    [1, '<</Type/Catalog/Pages 2 0 R>>'],
    [2, '<</Type/Pages/Kids[3 0 R]/Count 1>>'],
    [
      3,
      '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R' +
        '/Resources<</Font<</F1 5 0 R>>>>>>',
    ],
    [4, streamObject('', content)],
    [5, '<</Type/Font/Subtype/Type0/BaseFont/HeiseiMin-W3/Encoding/Identity-H/DescendantFonts[6 0 R]/ToUnicode 7 0 R>>'],
    [6, '<</Type/Font/Subtype/CIDFontType0/BaseFont/HeiseiMin-W3/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>>>'],
    [7, streamObject('', toUnicode)],
  ]);

  return assemblePdf(objects);
}

export type MixedPage = { kind: 'native'; text: string } | { kind: 'scan'; jpeg: Buffer };

/** Build a PDF whose pages can independently contain native text or a JPEG scan. */
export function buildMixedPdf(pages: readonly MixedPage[]): Uint8Array {
  const objects = new Map<number, PdfObject>();
  const pageIds = pages.map((_, index) => 3 + index);
  const contentStart = 3 + pages.length;
  const resourceStart = contentStart + pages.length;
  const fontId = resourceStart + pages.filter((page) => page.kind === 'scan').length;
  let nextImageId = resourceStart;

  objects.set(1, '<</Type/Catalog/Pages 2 0 R>>');
  objects.set(2, `<</Type/Pages/Kids[${pageIds.map((id) => `${id} 0 R`).join(' ')}]/Count ${pages.length}>>`);

  pages.forEach((page, index) => {
    const pageId = pageIds[index];
    const contentId = contentStart + index;

    if (page.kind === 'native') {
      const escaped = page.text.replace(/([()\\])/g, '\\$1');
      const content = Buffer.from(`BT /F1 14 Tf 72 700 Td (${escaped}) Tj ET`, 'binary');
      objects.set(
        pageId,
        `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${contentId} 0 R/Resources<</Font<</F1 ${fontId} 0 R>>>>>>`,
      );
      objects.set(contentId, streamObject('', content));
    } else {
      const imageId = nextImageId;
      nextImageId += 1;
      const content = Buffer.from('q 612 0 0 792 0 0 cm /Im1 Do Q', 'binary');
      objects.set(
        pageId,
        `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${contentId} 0 R/Resources<</XObject<</Im1 ${imageId} 0 R>>>>>>`,
      );
      objects.set(contentId, streamObject('', content));
      objects.set(
        imageId,
        streamObject(
          '/Type/XObject/Subtype/Image/Width 612/Height 792/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode',
          page.jpeg,
        ),
      );
    }
  });

  objects.set(fontId, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');
  return assemblePdf(objects);
}

/** Minimal Standard Security Handler fixture; parsing it requires a password. */
export function buildPasswordProtectedPdf(): Uint8Array {
  const content = Buffer.from('BT /F1 14 Tf 72 700 Td (secret document text) Tj ET', 'binary');
  const owner = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  const user = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';
  const fileId = '0123456789abcdef0123456789abcdef';
  const objects = new Map<number, PdfObject>([
    [1, '<</Type/Catalog/Pages 2 0 R>>'],
    [2, '<</Type/Pages/Kids[3 0 R]/Count 1>>'],
    [
      3,
      '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R' +
        '/Resources<</Font<</F1 5 0 R>>>>>>',
    ],
    [4, streamObject('', content)],
    [5, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'],
    [6, `<</Filter/Standard/V 1/R 2/Length 40/O <${owner}>/U <${user}>/P -4>>`],
  ]);

  return assemblePdf(objects, `/Encrypt 6 0 R/ID[<${fileId}><${fileId}>]`);
}

/**
 * Encode Japanese text as Shift-JIS.
 *
 * Node ships a Shift-JIS *decoder* only, so the reverse table is derived from it
 * once: every two-byte sequence in the lead/trail ranges is decoded and indexed
 * by the character it produces.
 */
function encodeShiftJis(text: string): Buffer {
  const decoder = new TextDecoder('shift_jis', { fatal: true });
  const table = new Map<string, [number, number]>();

  for (let lead = 0x81; lead <= 0xef; lead += 1) {
    if (lead >= 0xa0 && lead <= 0xdf) continue; // half-width katakana, single byte
    for (let trail = 0x40; trail <= 0xfc; trail += 1) {
      if (trail === 0x7f) continue;
      try {
        const char = decoder.decode(Uint8Array.from([lead, trail]));
        if (char.length === 1 && !table.has(char)) table.set(char, [lead, trail]);
      } catch {
        // Unassigned code point; nothing to map.
      }
    }
  }

  const bytes: number[] = [];
  for (const char of text) {
    const pair = table.get(char);
    if (!pair) throw new Error(`Not representable in Shift-JIS: ${char}`);
    bytes.push(...pair);
  }

  return Buffer.from(bytes);
}

/**
 * Japanese PDF that relies on a *predefined* CMap (`90ms-RKSJ-H`) rather than an
 * embedded one.
 *
 * This is the common shape for real-world Japanese PDFs, and the only fixture
 * that forces pdf.js to load a `.bcmap` from the packaged `cmaps` directory --
 * which is what makes it the regression guard for the `cMapUrl` prefix handed
 * to pdf.js in `src/lib/rag/pdf.ts`.
 */
export function buildPredefinedCMapJapanesePdf(text: string): Uint8Array {
  const content = Buffer.from(
    `BT /F1 14 Tf 72 700 Td <${encodeShiftJis(text).toString('hex')}> Tj ET`,
    'binary',
  );
  const objects = new Map<number, PdfObject>([
    [1, '<</Type/Catalog/Pages 2 0 R>>'],
    [2, '<</Type/Pages/Kids[3 0 R]/Count 1>>'],
    [
      3,
      '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R' +
        '/Resources<</Font<</F1 5 0 R>>>>>>',
    ],
    [4, streamObject('', content)],
    [
      5,
      '<</Type/Font/Subtype/Type0/BaseFont/KozMinPr6N-Regular/Encoding/90ms-RKSJ-H' +
        '/DescendantFonts[6 0 R]>>',
    ],
    [
      6,
      '<</Type/Font/Subtype/CIDFontType0/BaseFont/KozMinPr6N-Regular' +
        '/CIDSystemInfo<</Registry(Adobe)/Ordering(Japan1)/Supplement 6>>/DW 1000>>',
    ],
  ]);

  return assemblePdf(objects);
}
