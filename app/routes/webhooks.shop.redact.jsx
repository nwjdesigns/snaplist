import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  const { shop } = await authenticate.webhook(request);

  // Delete all data associated with the shop
  await prisma.generation.deleteMany({ where: { shop } });
  await prisma.push.deleteMany({ where: { shop } });
  await prisma.session.deleteMany({ where: { shop } });

  return new Response();
};
