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
