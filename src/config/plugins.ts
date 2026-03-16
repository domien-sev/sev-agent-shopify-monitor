export interface PluginConfig {
  name: string;
  description: string;
  /** Metafield namespaces that contain translatable content */
  metafieldNamespaces: string[];
  /** Whether this plugin has a separate API for translations */
  hasApi: boolean;
  /** Whether content needs manual checking (no API/metafield access) */
  manualCheckRequired: boolean;
  /** Last known check date key in shared memory */
  lastCheckMemoryKey: string;
  /** Reminder message for manual checks */
  reminderMessage: string;
}

/**
 * Registry of known Shopify apps with translatable content.
 * Each plugin may store translatable text in metafields, custom pages,
 * or through their own APIs that require manual checking.
 */
export const PLUGIN_REGISTRY: PluginConfig[] = [
  {
    name: "Rebuy",
    description: "AI-powered product recommendations and upsells with customizable widget text",
    metafieldNamespaces: ["rebuy"],
    hasApi: false,
    manualCheckRequired: true,
    lastCheckMemoryKey: "plugin_check:rebuy",
    reminderMessage:
      "Rebuy widget texts (add-to-cart buttons, recommendation headers, bundle labels) " +
      "need manual translation checks in the Rebuy dashboard. These are not accessible " +
      "via the Shopify Translations API.",
  },
  {
    name: "Judge.me",
    description: "Product reviews app with translatable email templates and widget labels",
    metafieldNamespaces: ["judgeme"],
    hasApi: false,
    manualCheckRequired: true,
    lastCheckMemoryKey: "plugin_check:judgeme",
    reminderMessage:
      "Judge.me review request emails, widget labels, and form text need manual " +
      "translation checks in the Judge.me dashboard under Settings > Languages.",
  },
  {
    name: "Klaviyo",
    description: "Email/SMS marketing with translatable flow content and signup forms",
    metafieldNamespaces: [],
    hasApi: true,
    manualCheckRequired: true,
    lastCheckMemoryKey: "plugin_check:klaviyo",
    reminderMessage:
      "Klaviyo email flows, signup forms, and SMS templates need manual translation " +
      "review. Check all active flows for French versions in the Klaviyo dashboard.",
  },
  {
    name: "Recharge",
    description: "Subscription management with translatable customer portal and notification text",
    metafieldNamespaces: ["recharge"],
    hasApi: false,
    manualCheckRequired: true,
    lastCheckMemoryKey: "plugin_check:recharge",
    reminderMessage:
      "Recharge subscription portal texts, email notifications, and checkout widget " +
      "labels need manual translation checks in the Recharge dashboard.",
  },
  {
    name: "Shopify Search & Discovery",
    description: "Native Shopify search with translatable boost/bury labels and filter names",
    metafieldNamespaces: ["shopify--discovery"],
    hasApi: false,
    manualCheckRequired: false,
    lastCheckMemoryKey: "plugin_check:search-discovery",
    reminderMessage:
      "Search & Discovery filter labels and synonyms should be checked for French translations.",
  },
];
