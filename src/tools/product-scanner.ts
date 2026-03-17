import type { ShopifyAdminClient, TranslatableResource } from "@domien-sev/shopify-sdk";
import { getTranslatableResources } from "@domien-sev/shopify-sdk";

/**
 * Scan all products with their translations for a given locale.
 * Uses the Shopify GraphQL Translations API with automatic pagination.
 * Logs progress per page since large stores can have 1000+ resources.
 */
export async function scanAllProducts(
  client: ShopifyAdminClient,
  locale: string = "fr",
): Promise<TranslatableResource[]> {
  console.log(`[product-scanner] Fetching all translatable resources for locale "${locale}"...`);

  const all: TranslatableResource[] = [];
  let after: string | undefined;
  let page = 0;

  while (true) {
    page++;
    const batch = await getTranslatableResources(client, locale, 50, after);
    all.push(...batch.resources);
    console.log(`[product-scanner] Page ${page}: ${batch.resources.length} resources (total: ${all.length})`);

    if (!batch.hasNextPage || !batch.endCursor) break;
    after = batch.endCursor;
  }

  console.log(`[product-scanner] Found ${all.length} translatable resources`);

  // Filter out resources that have no translatable content at all
  const withContent = all.filter((r) => r.translatableContent.length > 0);

  console.log(`[product-scanner] ${withContent.length} resources have translatable content`);

  return withContent;
}
