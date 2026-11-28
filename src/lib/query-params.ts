/** Decode a URL query component without throwing URIError on malformed percent-sequences. */
export function safeDecodeURIComponent(value: string | null | undefined): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
