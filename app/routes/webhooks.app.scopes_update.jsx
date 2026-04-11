import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  let payload, session, topic, shop;
  try {
    ({ payload, session, topic, shop } = await authenticate.webhook(request));
  } catch (error) {
    return new Response("Unauthorized", { status: 401 });
  }

  console.log(`Received ${topic} webhook for ${shop}`);
  const current = payload.current;

  if (session) {
    await db.session.update({
      where: {
        id: session.id,
      },
      data: {
        scope: current.toString(),
      },
    });
  }

  return new Response();
};
