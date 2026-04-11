import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  try {
    await authenticate.webhook(request);
  } catch (error) {
    return new Response("Unauthorized", { status: 401 });
  }
  // Snaplist does not store customer data, so nothing to return.
  return new Response();
};
