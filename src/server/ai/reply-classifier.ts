import OpenAI from "openai";
import { logger } from "@/server/logger";
import { getUserApiKey } from "@/server/api-keys/service";

export const VALID_REPLY_CATEGORIES = [
  "interested",
  "not_interested",
  "out_of_office",
  "bounce",
  "unsubscribe",
  "other",
  "uncategorized",
] as const;

export type ReplyCategoryType = (typeof VALID_REPLY_CATEGORIES)[number];

const AI_ASSIGNABLE_CATEGORIES = new Set<ReplyCategoryType>([
  "interested",
  "not_interested",
  "out_of_office",
  "bounce",
  "unsubscribe",
  "other",
]);

export interface ReplyClassificationResult {
  category: ReplyCategoryType;
  confidence: number | null;
  source: "ai" | "fallback";
}

/**
 * Strips excessive quoted email thread history and truncates reply text
 * to stay fast and cheap for LLM classification.
 */
export function prepareReplyTextForAi(rawBody = "", maxChars = 2000): string {
  if (!rawBody) return "";

  const lines = rawBody.split(/\r?\n/);
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Stop at standard reply quote headers
    if (
      /^On .+ wrote:\s*$/i.test(trimmed) ||
      /^-----Original Message-----/i.test(trimmed) ||
      /^From:\s.+@/i.test(trimmed) ||
      /^Sent:\s/i.test(trimmed) ||
      /^_{5,}$/.test(trimmed)
    ) {
      break;
    }
    // Skip quoted lines starting with '>'
    if (trimmed.startsWith(">")) {
      continue;
    }
    kept.push(line);
  }

  const cleaned = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (cleaned.length <= maxChars) {
    return cleaned;
  }
  return cleaned.slice(0, maxChars);
}

/**
 * Classifies an incoming lead reply using an LLM with a strict 10-second timeout.
 * Always fails safe to 'uncategorized' if API key is missing, rate-limited, timed out, or errors out.
 */
export async function classifyReplyIntent(input: {
  userId: string;
  subject?: string;
  bodyText?: string;
  timeoutMs?: number;
}): Promise<ReplyClassificationResult> {
  const provider = (process.env.REPLY_AI_PROVIDER || "openai").trim().toLowerCase();
  const model = (process.env.REPLY_AI_MODEL || "gpt-4o-mini").trim();
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 10000, 500), 10000);

  if (provider !== "openai") {
    return { category: "uncategorized", confidence: null, source: "fallback" };
  }

  let apiKey = "";
  try {
    apiKey = (await getUserApiKey(input.userId, "openai")) || "";
  } catch {}
  if (!apiKey) {
    apiKey = (process.env.REPLY_AI_API_KEY || process.env.OPENAI_API_KEY || "").trim();
  }

  if (!apiKey) {
    return { category: "uncategorized", confidence: null, source: "fallback" };
  }

  const cleanedBody = prepareReplyTextForAi(input.bodyText || "", 2000);
  const cleanSubject = (input.subject || "").trim().slice(0, 300);

  if (!cleanedBody && !cleanSubject) {
    return { category: "uncategorized", confidence: null, source: "fallback" };
  }

  try {
    const openai = new OpenAI({ apiKey, timeout: timeoutMs, maxRetries: 0 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const completion = await Promise.race([
        openai.chat.completions.create(
          {
            model,
            messages: [
              {
                role: "system",
                content:
                  'Classify the cold-email reply into EXACTLY ONE category: "interested", "not_interested", "out_of_office", "bounce", "unsubscribe", or "other". Respond ONLY with strict JSON: {"category":"...","confidence":0.0}.',
              },
              {
                role: "user",
                content: `Subject: ${cleanSubject}\n\nReply:\n${cleanedBody}`,
              },
            ],
            response_format: { type: "json_object" },
            temperature: 0,
            max_tokens: 80,
          },
          { signal: controller.signal }
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("AI reply classification timed out (10s limit)")), timeoutMs)
        ),
      ]);

      const raw = completion.choices[0]?.message?.content || "{}";
      const parsed = JSON.parse(raw);
      const rawCat = String(parsed.category || "").trim().toLowerCase() as ReplyCategoryType;

      if (!AI_ASSIGNABLE_CATEGORIES.has(rawCat)) {
        return { category: "uncategorized", confidence: null, source: "fallback" };
      }

      const confNum = Number(parsed.confidence);
      const confidence =
        Number.isFinite(confNum) && confNum >= 0 && confNum <= 1 ? confNum : null;

      return {
        category: rawCat,
        confidence,
        source: "ai",
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err: any) {
    logger.warn(
      { userId: input.userId, err: err?.message || String(err) },
      "AI reply classification failed/timed out; falling back to uncategorized"
    );
    return { category: "uncategorized", confidence: null, source: "fallback" };
  }
}
