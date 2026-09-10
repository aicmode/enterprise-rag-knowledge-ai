import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CitationList } from '@/components/ask/citation-card';
import type { Citation } from '@/lib/types';

function citation(overrides: Partial<Citation> = {}): Citation {
  return {
    index: 1,
    documentId: 'doc-1',
    documentTitle: '就業規則',
    fileName: '就業規則.pdf',
    pageNumber: 12,
    excerpt: '年次有給休暇の申請は、取得予定日の5営業日前までに提出してください。',
    similarity: 0.874,
    ...overrides,
  };
}

describe('CitationList', () => {
  it('renders nothing when there are no citations', () => {
    const { container } = render(<CitationList citations={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('shows the document title, page number and quoted text', () => {
    render(<CitationList citations={[citation()]} />);

    expect(screen.getByText('就業規則')).toBeInTheDocument();
    expect(screen.getByText('P.12')).toBeInTheDocument();
    expect(screen.getByText(/年次有給休暇の申請は/)).toBeInTheDocument();
  });

  it('shows the similarity as a percentage', () => {
    render(<CitationList citations={[citation({ similarity: 0.874 })]} />);

    expect(screen.getByText(/87%/)).toBeInTheDocument();
  });

  it('renders one entry per citation with the source count', () => {
    render(
      <CitationList
        citations={[
          citation({ index: 1, pageNumber: 12 }),
          citation({ index: 2, pageNumber: 34, documentId: 'doc-2', documentTitle: '経費規程' }),
        ]}
      />,
    );

    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText(/2件/)).toBeInTheDocument();
    expect(screen.getByText('P.12')).toBeInTheDocument();
    expect(screen.getByText('P.34')).toBeInTheDocument();
  });

  it('renders the excerpt inside a blockquote, marking it as quoted source text', () => {
    const { container } = render(<CitationList citations={[citation()]} />);

    const quote = container.querySelector('blockquote');
    expect(quote).not.toBeNull();
    expect(quote?.textContent).toContain('年次有給休暇');
  });

  it('handles a long document title without dropping the page number', () => {
    render(
      <CitationList
        citations={[citation({ documentTitle: '就業規則'.repeat(40), pageNumber: 99 })]}
      />,
    );

    expect(screen.getByText('P.99')).toBeInTheDocument();
  });
});
