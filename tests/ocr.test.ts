import { describe, expect, it } from 'vitest';

import { OCR_MAX_OUTPUT_TOKENS } from '@/lib/config/rag';
import { buildOcrRequest } from '@/lib/rag/ocr';

describe('buildOcrRequest', () => {
  it('uses the dedicated model and a high-detail image without storing history', () => {
    const request = buildOcrRequest('gpt-5-mini', {
      pageNumber: 2,
      imageDataUrl: 'data:image/png;base64,cGFnZQ==',
    });

    expect(request.model).toBe('gpt-5-mini');
    expect(request.store).toBe(false);
    expect(request.max_output_tokens).toBe(OCR_MAX_OUTPUT_TOKENS);
    expect(request.input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Transcribe PDF page 2.' },
          {
            type: 'input_image',
            image_url: 'data:image/png;base64,cGFnZQ==',
            detail: 'high',
          },
        ],
      },
    ]);
  });

  it('instructs transcription rather than summarization or translation', () => {
    const request = buildOcrRequest('vision-model', {
      pageNumber: 1,
      imageDataUrl: 'data:image/png;base64,eA==',
    });

    expect(request.instructions).toContain('Preserve the reading order');
    expect(request.instructions).toContain('Do not summarize');
    expect(request.instructions).toContain('Do not summarize, translate');
  });
});
