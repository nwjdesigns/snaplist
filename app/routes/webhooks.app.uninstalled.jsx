import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  let shop, session, topic;
  try {
    ({ shop, session, topic } = await authenticate.webhook(request));
  } catch (error) {
    return new Response("Unauthorized", { status: 401 });
  }

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  return new Response();
};
