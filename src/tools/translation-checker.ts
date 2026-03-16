import type { TranslatableResource } from "@domien-sev/shopify-sdk";

export interface TranslationCheckResult {
  resourceId: string;
  field: string;
  issueType: "missing" | "empty" | "outdated";
  sourceValue: string;
  currentTranslation: string | null;
  /** The digest of the source content, used to detect outdated translations */
  sourceDigest: string;
}

/**
 * Compare NL source content vs FR translations for each resource.
 * Detects missing, empty, and potentially outdated translations.
 *
 * @param resources - Translatable resources from the Shopify Translations API
 * @param locale - Target locale to check (default "fr")
 * @returns Array of detected translation issues
 */
export function checkTranslations(
  resources: TranslatableResource[],
  locale: string = "fr",
): TranslationCheckResult[] {
  const issues: TranslationCheckResult[] = [];

  for (const resource of resources) {
    // Build a map of existing translations for quick lookup
    const translationMap = new Map<string, string | null>();
    for (const t of resource.translations) {
      if (t.locale === locale) {
        translationMap.set(t.key, t.value);
      }
    }

    // Check each translatable content field
    for (const content of resource.translatableContent) {
      const sourceValue = content.value;

      // Skip empty source values — nothing to translate
      if (!sourceValue || !sourceValue.trim()) continue;

      // Skip non-translatable content (pure numbers, URLs, etc.)
      if (isNonTranslatable(sourceValue)) continue;

      const translation = translationMap.get(content.key);

      if (translation === undefined) {
        // No translation entry exists at all
        issues.push({
          resourceId: resource.resourceId,
          field: content.key,
          issueType: "missing",
          sourceValue,
          currentTranslation: null,
          sourceDigest: content.digest,
        });
      } else if (translation === null || translation.trim() === "") {
        // Translation entry exists but is empty
        issues.push({
          resourceId: resource.resourceId,
          field: content.key,
          issueType: "empty",
          sourceValue,
          currentTranslation: translation,
          sourceDigest: content.digest,
        });
      } else if (translation === sourceValue) {
        // Translation is identical to source — likely not translated yet
        // Only flag this for text fields, not for things like brand names
        if (sourceValue.length > 10 && containsWords(sourceValue)) {
          issues.push({
            resourceId: resource.resourceId,
            field: content.key,
            issueType: "outdated",
            sourceValue,
            currentTranslation: translation,
            sourceDigest: content.digest,
          });
        }
      }
    }
  }

  console.log(
    `[translation-checker] Checked ${resources.length} resources, found ${issues.length} issues ` +
    `(missing: ${issues.filter((i) => i.issueType === "missing").length}, ` +
    `empty: ${issues.filter((i) => i.issueType === "empty").length}, ` +
    `outdated: ${issues.filter((i) => i.issueType === "outdated").length})`,
  );

  return issues;
}

/**
 * Detect content that doesn't need translation (numbers, URLs, SKUs, etc.)
 */
function isNonTranslatable(value: string): boolean {
  const trimmed = value.trim();

  // Pure numbers (possibly with decimal/comma)
  if (/^[\d.,]+$/.test(trimmed)) return true;

  // URLs
  if (/^https?:\/\//.test(trimmed)) return true;

  // Email addresses
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return true;

  // SKU-like patterns (alphanumeric with dashes)
  if (/^[A-Z0-9][-A-Z0-9]{2,}$/i.test(trimmed) && trimmed.length < 20) return true;

  // HTML-only content with no visible text
  const textContent = trimmed.replace(/<[^>]*>/g, "").trim();
  if (textContent.length === 0 && trimmed.length > 0) return true;

  return false;
}

/**
 * Check if a string contains actual words (not just codes/identifiers)
 */
function containsWords(value: string): boolean {
  // Strip HTML tags
  const text = value.replace(/<[^>]*>/g, " ");
  // Check for at least one word with 3+ characters
  return /[a-zA-ZÀ-ÿ]{3,}/.test(text);
}
