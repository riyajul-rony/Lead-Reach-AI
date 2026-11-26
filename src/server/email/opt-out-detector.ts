const EXACT_OPT_OUT_PHRASES = new Set<string>([
  "stop",
  "please stop",
  "stop emailing",
  "stop emailing me",
  "please stop emailing",
  "please stop emailing me",
  "stop contacting me",
  "please stop contacting me",
  "unsubscribe",
  "please unsubscribe",
  "unsubscribe me",
  "please unsubscribe me",
  "remove me",
  "please remove me",
  "remove my email",
  "please remove my email",
  "opt out",
  "opt-out",
  "opt me out",
  "please opt me out",
  "not interested, stop",
  "not interested - stop",
  "not interested. stop",
  "not interested stop",
  "no thanks, stop",
  "no thank you, stop",
]);

/**
 * Extracts the first non-empty, non-quoted line from a reply body.
 * Stops immediately if a reply quote header begins ("On ... wrote:", "-----Original Message-----", etc.)
 * and skips leading quote lines starting with '>'.
 */
export function extractFirstNonQuotedLine(bodyText = ""): string {
  if (!bodyText) return "";

  const lines = bodyText.replace(/\r\n/g, "\n").split("\n");
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    if (
      /^On .+ wrote:\s*$/i.test(trimmed) ||
      /^-----Original Message-----/i.test(trimmed) ||
      /^From:\s.+@/i.test(trimmed) ||
      /^Sent:\s/i.test(trimmed) ||
      /^_{5,}$/.test(trimmed)
    ) {
      break;
    }

    if (trimmed.startsWith(">")) {
      continue;
    }

    return trimmed;
  }

  return "";
}

/**
 * Conservative, deterministic opt-out reply detector.
 * Evaluates ONLY the first non-quoted line against a strict allowlist of exact opt-out commands.
 * Never performs fuzzy/substring matching so phrases like "don't stop now" or
 * "please don't unsubscribe me" never false-positive.
 */
export function detectDeterministicOptOut(bodyText = ""): {
  isOptOut: boolean;
  firstLine: string;
  matchedPhrase?: string;
} {
  const firstLine = extractFirstNonQuotedLine(bodyText);
  if (!firstLine) {
    return { isOptOut: false, firstLine: "" };
  }

  const normalized = firstLine
    .toLowerCase()
    .replace(/^[`"'(\s-]+/, "")
    .replace(/[`"').!?,;:…\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized || normalized.length > 60) {
    return { isOptOut: false, firstLine };
  }

  if (EXACT_OPT_OUT_PHRASES.has(normalized)) {
    return { isOptOut: true, firstLine, matchedPhrase: normalized };
  }

  return { isOptOut: false, firstLine };
}
