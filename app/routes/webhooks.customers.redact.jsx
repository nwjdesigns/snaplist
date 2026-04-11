import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  await authenticate.webhook(request);
  // Snaplist does not store customer data, so nothing to redact.
  return new Response();
};
