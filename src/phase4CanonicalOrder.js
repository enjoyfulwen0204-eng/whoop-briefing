/** Exact UTF-16 code-unit order: deterministic across locales, with equality
 * only for identical strings. No Unicode normalization of opaque identifiers. */
export const compareExact=(left,right)=>left<right?-1:left>right?1:0;
