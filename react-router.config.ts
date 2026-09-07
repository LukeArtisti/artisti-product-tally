import type { Config } from "@react-router/dev/config";

export default {
  // Shopify CLI proxies the app through a tunnel, so the Origin host
  // (trycloudflare / admin.shopify.com) often differs from request.url.
  allowedActionOrigins: [
    "admin.shopify.com",
    "**.shopify.com",
    "**.myshopify.com",
    "**.trycloudflare.com",
    "*",
    "**",
  ],
} satisfies Config;
