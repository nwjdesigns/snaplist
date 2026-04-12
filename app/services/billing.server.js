import prisma from "../db.server";
import { authenticate } from "../shopify.server";

const FREE_GENERATION_LIMIT = 5;
const PRO_GENERATION_LIMIT = 500;
const PRO_PLAN = "Pro";

/**
 * Count how many generations a shop has used this calendar month.
 */
export async function getMonthlyUsage(shop) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  return prisma.generation.count({
    where: {
      shop,
      createdAt: { gte: startOfMonth },
    },
  });
}

/**
 * Record a generation for a shop.
 */
export async function recordGeneration(shop, productId, output) {
  return prisma.generation.create({
    data: {
      shop,
      productId,
      output: JSON.stringify(output),
    },
  });
}

/**
 * Check if the shop has an active Pro subscription via Shopify Billing API.
 */
export async function hasProPlan(admin) {
  const response = await admin.graphql(`
    #graphql
    query {
      app {
        installation {
          activeSubscriptions {
            name
            status
          }
        }
      }
    }
  `);

  const data = await response.json();
  const subscriptions = data.data.app.installation.activeSubscriptions || [];
  return subscriptions.some(
    (sub) => sub.name === PRO_PLAN && sub.status === "ACTIVE",
  );
}

/**
 * Check whether the shop can generate (has Pro plan or is under free limit).
 * Returns { allowed, usage, limit, isPro }.
 */
export async function checkGenerationAccess(admin, shop) {
  const isPro = await hasProPlan(admin);

  if (isPro) {
    const usage = await getMonthlyUsage(shop);
    return {
      allowed: usage < PRO_GENERATION_LIMIT,
      usage,
      limit: null, // Don't expose the hard cap in the UI
      isPro: true,
    };
  }

  const usage = await getMonthlyUsage(shop);
  return {
    allowed: usage < FREE_GENERATION_LIMIT,
    usage,
    limit: FREE_GENERATION_LIMIT,
    isPro: false,
  };
}

/**
 * Create a Pro subscription charge via Shopify Billing API.
 * Returns the confirmation URL the merchant needs to visit.
 */
export async function createProSubscription(admin) {
  const response = await admin.graphql(
    `#graphql
    mutation createSubscription($name: String!, $lineItems: [AppSubscriptionLineItemInput!]!, $returnUrl: URL!, $test: Boolean) {
      appSubscriptionCreate(
        name: $name
        lineItems: $lineItems
        returnUrl: $returnUrl
        test: $test
      ) {
        appSubscription {
          id
        }
        confirmationUrl
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        name: PRO_PLAN,
        test: process.env.SHOPIFY_TEST_CHARGES === "true" || process.env.NODE_ENV !== "production",
        returnUrl: `${process.env.SHOPIFY_APP_URL}/app/billing`,
        lineItems: [
          {
            plan: {
              appRecurringPricingDetails: {
                price: { amount: 19.0, currencyCode: "USD" },
                interval: "EVERY_30_DAYS",
              },
            },
          },
        ],
      },
    },
  );

  const result = await response.json();
  const { confirmationUrl, userErrors } =
    result.data.appSubscriptionCreate;

  if (userErrors.length > 0) {
    throw new Error(userErrors.map((e) => e.message).join(", "));
  }

  return confirmationUrl;
}

/**
 * Send a Slack alert via incoming webhook.
 * Set SLACK_ALERT_WEBHOOK in your .env to enable.
 */
export async function slackAlert(text) {
  const url = process.env.SLACK_ALERT_WEBHOOK;
  if (!url) {
    console.warn("[slackAlert] No SLACK_ALERT_WEBHOOK set, skipping:", text);
    return;
  }

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error("[slackAlert] Failed to send:", err.message);
  }
}

/**
 * Notify when a Pro merchant hits the hard generation cap.
 */
export async function notifyProCapReached(shop, usage) {
  await slackAlert(
    `🚨 *Pro cap reached* — \`${shop}\` hit ${usage} generations this month. Review and raise limit if appropriate.`,
  );
}

/**
 * Check if this is the shop's very first generation (before recording the new one).
 */
export async function isFirstGeneration(shop) {
  const count = await prisma.generation.count({ where: { shop } });
  return count === 0;
}

/**
 * Check if this is the shop's first push. Record the push and return whether it was the first.
 */
export async function recordPushAndCheckFirst(shop, productId) {
  const existing = await prisma.push.count({ where: { shop } });
  await prisma.push.create({ data: { shop, productId } });
  return existing === 0;
}

// --- Alert functions ---

export async function alertNewProSubscription(shop) {
  await slackAlert(`💰 *New Pro subscriber!* — \`${shop}\` just upgraded to Pro ($19/mo)`);
}

export async function alertSubscriptionCancelled(shop) {
  await slackAlert(`🚪 *Churn* — \`${shop}\` cancelled their Pro subscription`);
}

export async function alertFreeLimitHit(shop) {
  await slackAlert(`🔥 *Free limit hit* — \`${shop}\` used all 5 free generations this month. Hot conversion lead.`);
}

export async function alertFirstGeneration(shop) {
  await slackAlert(`🆕 *First generation!* — \`${shop}\` just generated their first listing. New activated user.`);
}

export async function alertFirstPush(shop, productId) {
  await slackAlert(`🚀 *First push!* — \`${shop}\` pushed a listing live to their store. Aha moment.`);
}

export async function alertGenerationFailed(shop, errorMessage) {
  await slackAlert(`❌ *Generation failed* — \`${shop}\`: ${errorMessage}`);
}
