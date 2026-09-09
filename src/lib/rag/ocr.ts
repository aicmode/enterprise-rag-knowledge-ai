import 'server-only';

import OpenAI from 'openai';
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';

import { getRagConfig } from '@/lib/config/env';
import { OCR_MAX_OUTPUT_TOKENS, OCR_TIMEOUT_MS } from '@/lib/config/rag';
import { AppError } from '@/lib/errors';
import { getOpenAIClient } from './openai';

export interface OcrPageInput {
  /** Original 1-based PDF page number. */
  pageNumber: number;
  /** Server-generated page image; never a public Storage URL. */
  imageDataUrl: `data:image/png;base64,${string}`;
}

/** Injectable seam used by the PDF pipeline and deterministic tests. */
export type OcrPage = (input: OcrPageInput) => Promise<string>;

const OCR_INSTRUCTIONS = `You are an OCR engine for enterprise documents.
Transcribe every readable character from the supplied single PDF page image.
Preserve the reading order, paragraph breaks, Japanese, English, numbers, and punctuation.
Do not summarize, translate, explain, add Markdown fences, or invent missing text.
Return only the transcription. Return an empty string when no text is readable.`;

export function buildOcrRequest(
  model: string,
  input: OcrPageInput,
): ResponseCreateParamsNonStreaming {
  return {
    model,
    instructions: OCR_INSTRUCTIONS,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: `Transcribe PDF page ${input.pageNumber}.` },
          {
            type: 'input_image',
            image_url: input.imageDataUrl,
            // High detail is supported across the intended model families and
            // gives OCR enough detail without the larger original bill.
            detail: 'high',
          },
        ],
      },
    ],
    max_output_tokens: OCR_MAX_OUTPUT_TOKENS,
    // Independent one-shot operation: no response history is needed.
    store: false,
  };
}

/** Transcribe one rendered PDF page with a vision-capable model. */
export async function ocrPageImage(input: OcrPageInput): Promise<string> {
  const openai = getOpenAIClient();
  const model = getRagConfig().ocrModel;

  try {
    const response = await openai.responses.create(
      buildOcrRequest(model, input),
      { timeout: OCR_TIMEOUT_MS, maxRetries: 2 },
    );

    return response.output_text.trim();
  } catch (error) {
    if (error instanceof OpenAI.APIConnectionTimeoutError) {
      throw new AppError('ocr_timeout', { cause: error, detail: 'OpenAI OCR request timed out' });
    }

    throw new AppError('ocr_failed', {
      cause: error,
      detail: error instanceof Error ? error.message : 'OpenAI OCR request failed',
    });
  }
}
