/** Decode a URL query component without throwing URIError on malformed percent-sequences. */
export function safeDecodeURIComponent(value: string | null | undefined): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Parse a 1-based page query parameter safely, returning fallback for non-numeric or < 1 inputs. */
export function parsePageParam(value: string | null | undefined, fallback = 1): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}
