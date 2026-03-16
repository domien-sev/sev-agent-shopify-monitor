import Anthropic from "@anthropic-ai/sdk";
import { QUALITY_CHECK_PROMPT } from "../prompts/quality-check.js";

export interface TranslationPair {
  field: string;
  source: string;
  translation: string;
  deeplSuggestion: string;
}

export interface QualityResult {
  field: string;
  score: number;
  reasoning: string;
}

const BATCH_SIZE = 5;

/**
 * Use Claude to evaluate translation quality by comparing existing translations
 * against the Dutch source and a DeepL reference translation.
 *
 * @param pairs - Array of source/translation/DeepL triplets to evaluate
 * @param anthropicApiKey - Anthropic API key for Claude access
 * @returns Quality scores and reasoning for each translation pair
 */
export async function evaluateTranslationQuality(
  pairs: TranslationPair[],
  anthropicApiKey: string,
): Promise<QualityResult[]> {
  if (!anthropicApiKey) {
    console.warn("[quality-evaluator] No Anthropic API key — skipping quality evaluation");
    return pairs.map((p) => ({
      field: p.field,
      score: -1,
      reasoning: "Quality evaluation skipped: no Anthropic API key configured",
    }));
  }

  if (pairs.length === 0) return [];

  const client = new Anthropic({ apiKey: anthropicApiKey });
  const results: QualityResult[] = [];

  // Process in batches to avoid hitting token limits
  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const batch = pairs.slice(i, i + BATCH_SIZE);
    console.log(
      `[quality-evaluator] Evaluating batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(pairs.length / BATCH_SIZE)} ` +
      `(${batch.length} pairs)`,
    );

    const batchResults = await evaluateBatch(client, batch);
    results.push(...batchResults);
  }

  return results;
}

async function evaluateBatch(
  client: Anthropic,
  batch: TranslationPair[],
): Promise<QualityResult[]> {
  const pairsText = batch
    .map((pair, idx) => {
      return [
        `### Translation ${idx + 1}: ${pair.field}`,
        `**Dutch source:** ${pair.source}`,
        `**Current French translation:** ${pair.translation}`,
        `**DeepL reference:** ${pair.deeplSuggestion}`,
      ].join("\n");
    })
    .join("\n\n");

  const userMessage = [
    "Evaluate the following translations. For each one, provide a JSON object with fields: " +
    "`field` (string), `score` (number 0-1), and `reasoning` (string).",
    "",
    "Return a JSON array with one object per translation.",
    "",
    pairsText,
  ].join("\n");

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: QUALITY_CHECK_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    // Extract text from response
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    // Parse JSON from response (may be wrapped in markdown code block)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.warn("[quality-evaluator] Could not parse JSON from Claude response");
      return batch.map((p) => ({
        field: p.field,
        score: -1,
        reasoning: "Failed to parse quality evaluation response",
      }));
    }

    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      field?: string;
      score?: number;
      reasoning?: string;
    }>;

    return batch.map((pair, idx) => ({
      field: pair.field,
      score: typeof parsed[idx]?.score === "number" ? parsed[idx].score : -1,
      reasoning: parsed[idx]?.reasoning ?? "No reasoning provided",
    }));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[quality-evaluator] Claude API error: ${errMsg}`);
    return batch.map((p) => ({
      field: p.field,
      score: -1,
      reasoning: `Quality evaluation failed: ${errMsg}`,
    }));
  }
}
