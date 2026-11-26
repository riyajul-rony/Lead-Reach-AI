/**
 * High-performance, zero-dependency email variable template renderer.
 * Optimized for lightweight VPS (1 vCPU, 4GB RAM).
 */

export interface RenderVariables {
  [key: string]: string | number | undefined | null;
}

/**
 * Resolves standard and nested {option1|option2} spintax blocks while protecting
 * {{merge_tag}} placeholders from being altered. Unclosed or non-spintax braces
 * fall back gracefully as literal text.
 */
export function resolveSpintax(
  template: string,
  rng: () => number = Math.random
): string {
  if (!template) return "";

  const protectedTags: string[] = [];
  // Protect {{...}} merge tags before spinning single-brace {a|b} blocks
  let working = template.replace(/\{\{[\s\S]*?\}\}/g, (match) => {
    const idx = protectedTags.length;
    protectedTags.push(match);
    return `\u0000LR_TAG_${idx}\u0000`;
  });

  const spintaxRegex = /\{([^{}]*\|[^{}]*)\}/g;
  for (let pass = 0; pass < 25; pass++) {
    let changed = false;
    working = working.replace(spintaxRegex, (_match, inner: string) => {
      changed = true;
      const options = inner.split("|");
      const rawPick = rng();
      const bounded = Number.isFinite(rawPick) ? Math.min(Math.max(rawPick, 0), 0.999999999) : 0;
      const idx = Math.floor(bounded * options.length);
      return options[idx] ?? "";
    });
    if (!changed) break;
  }

  return working.replace(/\u0000LR_TAG_(\d+)\u0000/g, (_m, idxStr: string) => {
    const idx = Number(idxStr);
    return protectedTags[idx] ?? "";
  });
}

export function renderEmailTemplate(
  template: string,
  vars: RenderVariables,
  unsubscribeUrl?: string,
  rng: () => number = Math.random
): string {
  if (!template) return "";

  // 1. Resolve spintax BEFORE merge variable substitution so scraped lead data containing {...} is never spun
  const spun = resolveSpintax(template, rng);

  // 2. Replace {{unsubscribe_url}} if present
  let result = spun.replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, unsubscribeUrl || "#");

  // 3. Replace {{key|fallback}} or {{key}}
  result = result.replace(/\{\{\s*([a-zA-Z0-9_-]+)(?:\|([^}]+))?\s*\}\}/g, (_, key, fallback) => {
    const trimmedKey = key.trim();
    const val = vars[trimmedKey];

    if (val !== undefined && val !== null && String(val).trim() !== "") {
      return String(val);
    }

    return fallback !== undefined ? fallback : "";
  });

  return result;
}

/**
 * Extracts all unique variable placeholders found in a template string.
 */
export function extractTemplateVariables(template: string): string[] {
  const matches = template.matchAll(/\{\{\s*([a-zA-Z0-9_-]+)(?:\|[^}]+)?\s*\}\}/g);
  const keys = new Set<string>();
  for (const match of matches) {
    if (match[1] && match[1] !== "unsubscribe_url") {
      keys.add(match[1]);
    }
  }
  return Array.from(keys);
}
