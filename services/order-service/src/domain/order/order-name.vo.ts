export interface NormalizedName {
  normalized: string;
  tokens: string[];
}

/** Strips diacritics and lowercases for prefix matching; tokenizes on ANY
 *  non-letter/non-number boundary (spaces, hyphens, em-dashes, slashes)
 *  so "Nike SS26 Apparel — Batch 04" splits into five clean tokens. */
export function normalizeOrderName(raw: string): NormalizedName {
  const normalized = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
  const tokens = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return { normalized, tokens };
}
