import type { ShopifyAdminClient, TranslatableResource } from "@domien-sev/shopify-sdk";
import { getAllTranslatableResources } from "@domien-sev/shopify-sdk";

/**
 * Scan all products with their translations for a given locale.
 * Uses the Shopify GraphQL Translations API with automatic pagination.
 *
 * @param client - Shopify Admin API client
 * @param locale - Target locale to check translations for (default "fr")
 * @returns All translatable resources with their source content and translations
 */
export async function scanAllProducts(
  client: ShopifyAdminClient,
  locale: string = "fr",
): Promise<TranslatableResource[]> {
  console.log(`[product-scanner] Fetching all translatable resources for locale "${locale}"...`);

  const resources = await getAllTranslatableResources(client, locale);

  console.log(`[product-scanner] Found ${resources.length} translatable resources`);

  // Filter out resources that have no translatable content at all
  const withContent = resources.filter((r) => r.translatableContent.length > 0);

  console.log(`[product-scanner] ${withContent.length} resources have translatable content`);

  return withContent;
}
