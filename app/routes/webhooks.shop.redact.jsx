import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  let shop;
  try {
    const result = await authenticate.webhook(request);
    shop = result.shop;
  } catch (error) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Delete all data associated with the shop
  await prisma.generation.deleteMany({ where: { shop } });
  await prisma.push.deleteMany({ where: { shop } });
  await prisma.session.deleteMany({ where: { shop } });

  return new Response();
};
