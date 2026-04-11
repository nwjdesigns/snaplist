import { authenticate } from "../shopify.server";
import { alertSubscriptionCancelled } from "../services/billing.server";

export const action = async ({ request }) => {
  let shop, payload;
  try {
    ({ shop, payload } = await authenticate.webhook(request));
  } catch (error) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Shopify sends this webhook when a subscription status changes
  // payload.app_subscription.status can be: ACTIVE, CANCELLED, DECLINED, EXPIRED, FROZEN, PENDING
  const subscription = payload?.app_subscription;
  if (subscription?.status === "CANCELLED") {
    alertSubscriptionCancelled(shop);
  }

  return new Response();
};
