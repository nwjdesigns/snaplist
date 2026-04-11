import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import { json, redirect } from "@remix-run/node";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  Badge,
  Divider,
  Icon,
  List,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { checkGenerationAccess, createProSubscription, alertNewProSubscription } from "../services/billing.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const access = await checkGenerationAccess(admin, session.shop);

  // Check if merchant just returned from approving the subscription
  const url = new URL(request.url);
  if (url.searchParams.get("charge_id")) {
    alertNewProSubscription(session.shop);
  }

  return json({ access });
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "subscribe") {
    const confirmationUrl = await createProSubscription(admin);
    return redirect(confirmationUrl);
  }

  return json({ error: "Unknown action" }, { status: 400 });
};

export default function BillingPage() {
  const { access } = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();

  return (
    <Page
      backAction={{ onAction: () => navigate("/app") }}
      title="Plans"
    >
      <Layout>
        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingLg">
                  Free
                </Text>
                {!access.isPro && <Badge tone="info">Current plan</Badge>}
              </InlineStack>
              <Text variant="headingXl">$0</Text>
              <Text variant="bodySm" tone="subdued">per month</Text>
              <Divider />
              <List>
                <List.Item>5 generations per month</List.Item>
                <List.Item>Full listing generation (title, description, tags, SEO)</List.Item>
                <List.Item>Push to Shopify</List.Item>
              </List>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingLg">
                  Pro
                </Text>
                {access.isPro && <Badge tone="success">Current plan</Badge>}
              </InlineStack>
              <InlineStack blockAlign="baseline" gap="100">
                <Text variant="headingXl">$19</Text>
                <Text variant="bodySm" tone="subdued">/ month</Text>
              </InlineStack>
              <Divider />
              <List>
                <List.Item>Unlimited generations</List.Item>
                <List.Item>Full listing generation (title, description, tags, SEO)</List.Item>
                <List.Item>Push to Shopify</List.Item>
                <List.Item>Priority support</List.Item>
              </List>
              {!access.isPro ? (
                <fetcher.Form method="POST">
                  <input type="hidden" name="intent" value="subscribe" />
                  <Button
                    variant="primary"
                    size="large"
                    fullWidth
                    submit
                    loading={fetcher.state !== "idle"}
                  >
                    Upgrade to Pro
                  </Button>
                </fetcher.Form>
              ) : (
                <Banner tone="success">
                  <p>You're on the Pro plan. Enjoy unlimited generations!</p>
                </Banner>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>

      {!access.isPro && (
        <div style={{ marginTop: "16px" }}>
          <Banner tone="info">
            <p>
              You've used {access.usage} of {access.limit} free generations this month.
              Upgrade to Pro to remove the limit.
            </p>
          </Banner>
        </div>
      )}
    </Page>
  );
}
