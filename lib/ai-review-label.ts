/**
 * How the models' opinion is written on the card and in a notification. Kept
 * apart from the code that asks them, so the browser never loads their SDKs.
 */

import type { AiReview, ReviewProvider } from './types';

/** A short label for the single Gemini opinion. */
export function reviewLabel(review: AiReview | null | undefined): string | null {
  if (!review || review.answered === 0) return null;
  return `AI: ${review.agree} of ${review.answered} agree`;
}

export const PROVIDER_NAMES: Record<ReviewProvider, string> = {
  gemini: 'Gemini',
};
