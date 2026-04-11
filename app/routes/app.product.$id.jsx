import { useState, useEffect, useCallback, useRef } from "react";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import {
  json,
  unstable_parseMultipartFormData,
  unstable_createMemoryUploadHandler,
} from "@remix-run/node";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  Box,
  Tag,
  TextField,
  ProgressBar,
  DropZone,
  Divider,
  Icon,
  Badge,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { generateListing } from "../services/ai.server";
import {
  checkGenerationAccess,
  recordGeneration,
  notifyProCapReached,
  isFirstGeneration,
  recordPushAndCheckFirst,
  alertFreeLimitHit,
  alertFirstGeneration,
  alertFirstPush,
  alertGenerationFailed,
} from "../services/billing.server";

export const loader = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);

  const [response, access] = await Promise.all([
    admin.graphql(
      `#graphql
      query getProduct($id: ID!) {
        product(id: $id) {
          id
          title
          descriptionHtml
          status
          tags
          seo {
            title
            description
          }
          images(first: 5) {
            edges {
              node {
                url
                altText
              }
            }
          }
        }
      }`,
      {
        variables: {
          id: `gid://shopify/Product/${params.id}`,
        },
      },
    ),
    checkGenerationAccess(admin, session.shop),
  ]);

  const data = await response.json();
  const product = data.data.product;

  if (!product) {
    throw new Response("Product not found", { status: 404 });
  }

  return json({
    product: {
      id: product.id,
      numericId: params.id,
      title: product.title,
      descriptionHtml: product.descriptionHtml || "",
      status: product.status,
      tags: product.tags,
      seoTitle: product.seo?.title || "",
      seoDescription: product.seo?.description || "",
      images: product.images.edges.map(({ node }) => ({
        url: node.url,
        alt: node.altText || product.title,
      })),
    },
    access,
  });
};

export const action = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const contentType = request.headers.get("content-type") || "";

  let formData;
  if (contentType.includes("multipart/form-data")) {
    const uploadHandler = unstable_createMemoryUploadHandler({
      maxPartSize: 10_000_000,
    });
    formData = await unstable_parseMultipartFormData(request, uploadHandler);
  } else {
    formData = await request.formData();
  }

  const intent = formData.get("intent");

  if (intent === "generate") {
    // Check usage limits before generating
    const access = await checkGenerationAccess(admin, session.shop);
    if (!access.allowed) {
      if (access.isPro) {
        notifyProCapReached(session.shop, access.usage);
      } else {
        alertFreeLimitHit(session.shop);
      }
      const message = access.isPro
        ? "You've reached the monthly generation limit. Please contact support."
        : "You've used all 5 free generations this month. Upgrade to Pro for unlimited listings.";
      return json({
        error: message,
        limitReached: !access.isPro,
      }, { status: 403 });
    }

    const imageUrl = formData.get("imageUrl");
    const uploadedFile = formData.get("uploadedImage");

    if (!imageUrl && !uploadedFile?.size) {
      return json({ error: "No image available to analyze" }, { status: 400 });
    }

    try {
      // Check if this is their first-ever generation (before recording)
      const firstGen = await isFirstGeneration(session.shop);

      let listing;
      if (uploadedFile?.size) {
        const buffer = Buffer.from(await uploadedFile.arrayBuffer());
        const base64 = buffer.toString("base64");
        listing = await generateListing({
          imageBase64: base64,
          imageMimeType: uploadedFile.type,
        });
      } else {
        listing = await generateListing({ imageUrl });
      }

      // Record the generation
      await recordGeneration(
        session.shop,
        `gid://shopify/Product/${params.id}`,
        listing,
      );

      // Alert on first generation (fire-and-forget)
      if (firstGen) {
        alertFirstGeneration(session.shop);
      }

      return json({ listing, usage: access.usage + 1 });
    } catch (error) {
      console.error("Generation error:", error);
      // Alert on Gemini/AI failure
      alertGenerationFailed(session.shop, error.message);
      return json(
        { error: `Failed to generate listing: ${error.message}` },
        { status: 500 },
      );
    }
  }

  if (intent === "push") {
    const title = formData.get("title");
    const description = formData.get("description");
    const tags = formData.get("tags");
    const seoTitle = formData.get("seoTitle");
    const seoDescription = formData.get("seoDescription");

    const response = await admin.graphql(
      `#graphql
      mutation updateProduct($input: ProductInput!) {
        productUpdate(input: $input) {
          product {
            id
            title
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          input: {
            id: `gid://shopify/Product/${params.id}`,
            title,
            descriptionHtml: description,
            tags: tags.split(",").map((t) => t.trim()),
            seo: {
              title: seoTitle,
              description: seoDescription,
            },
          },
        },
      },
    );

    const result = await response.json();
    const errors = result.data.productUpdate.userErrors;

    if (errors.length > 0) {
      return json(
        { error: errors.map((e) => e.message).join(", ") },
        { status: 400 },
      );
    }

    // Track push and alert on first-ever push
    const productGid = `gid://shopify/Product/${params.id}`;
    const firstPush = await recordPushAndCheckFirst(session.shop, productGid);
    if (firstPush) {
      alertFirstPush(session.shop, productGid);
    }

    return json({ pushed: true });
  }

  return json({ error: "Unknown action" }, { status: 400 });
};

// --- Components ---

const PROGRESS_STEPS = [
  { label: "Uploading image...", progress: 15 },
  { label: "Analyzing product...", progress: 35 },
  { label: "Identifying features...", progress: 55 },
  { label: "Writing copy...", progress: 75 },
  { label: "Optimizing SEO...", progress: 90 },
];

function GeneratingProgress() {
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setStepIndex((prev) =>
        prev < PROGRESS_STEPS.length - 1 ? prev + 1 : prev,
      );
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  const step = PROGRESS_STEPS[stepIndex];

  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd">
          Generating listing...
        </Text>
        <ProgressBar progress={step.progress} size="small" tone="primary" />
        <Text variant="bodySm" tone="subdued">
          {step.label}
        </Text>
      </BlockStack>
    </Card>
  );
}

function ComparisonField({ label, before, after }) {
  const changed = before !== after;
  return (
    <BlockStack gap="100">
      <Text variant="headingSm">{label}</Text>
      {changed ? (
        <InlineStack gap="400" wrap={false}>
          <Box
            width="50%"
            padding="300"
            background="bg-surface-critical-subdued"
            borderRadius="200"
          >
            <Text variant="bodySm" tone="subdued">
              Before
            </Text>
            <div
              style={{ marginTop: "4px" }}
              dangerouslySetInnerHTML={{ __html: before || "<em>Empty</em>" }}
            />
          </Box>
          <Box
            width="50%"
            padding="300"
            background="bg-surface-success-subdued"
            borderRadius="200"
          >
            <Text variant="bodySm" tone="subdued">
              After
            </Text>
            <div
              style={{ marginTop: "4px" }}
              dangerouslySetInnerHTML={{ __html: after || "<em>Empty</em>" }}
            />
          </Box>
        </InlineStack>
      ) : (
        <Text variant="bodySm" tone="subdued">
          No change
        </Text>
      )}
    </BlockStack>
  );
}

function EditableTags({ tags, onChange }) {
  const [inputValue, setInputValue] = useState("");

  const addTag = () => {
    const trimmed = inputValue.trim();
    if (trimmed && !tags.includes(trimmed)) {
      onChange([...tags, trimmed]);
      setInputValue("");
    }
  };

  const removeTag = (index) => {
    onChange(tags.filter((_, i) => i !== index));
  };

  return (
    <BlockStack gap="200">
      <Text as="h3" variant="headingSm">
        Tags
      </Text>
      <InlineStack gap="100" wrap>
        {tags.map((tag, i) => (
          <Tag key={i} onRemove={() => removeTag(i)}>
            {tag}
          </Tag>
        ))}
      </InlineStack>
      <InlineStack gap="200">
        <div
          style={{ flex: 1 }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addTag();
            }
          }}
        >
          <TextField
            label="Add tag"
            labelHidden
            value={inputValue}
            onChange={setInputValue}
            placeholder="Add a tag..."
            autoComplete="off"
          />
        </div>
        <Button onClick={addTag} disabled={!inputValue.trim()}>
          Add
        </Button>
      </InlineStack>
    </BlockStack>
  );
}

// --- Main Page ---

export default function ProductPage() {
  const { product, access } = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();

  const [uploadedFile, setUploadedFile] = useState(null);
  const [uploadedPreview, setUploadedPreview] = useState(null);
  const [editedListing, setEditedListing] = useState(null);
  const [showComparison, setShowComparison] = useState(false);

  // Snapshot the original product state on first render so comparison
  // always shows "before generation" vs "after generation"
  const originalProduct = useRef(product);
  const original = originalProduct.current;

  const isGenerating =
    fetcher.state !== "idle" &&
    fetcher.formData?.get("intent") === "generate";
  const isPushing =
    fetcher.state !== "idle" &&
    fetcher.formData?.get("intent") === "push";

  const listing = fetcher.data?.listing || null;
  const error = fetcher.data?.error || null;
  const pushed = fetcher.data?.pushed || false;
  const limitReached = fetcher.data?.limitReached || false;

  // Track usage: start from loader, increment after successful generation
  const currentUsage = fetcher.data?.usage ?? access.usage;
  const atLimit = !access.isPro && currentUsage >= (access.limit || 5);

  if (listing && !editedListing) {
    setEditedListing(listing);
  }

  const current = editedListing || listing;

  const handleDropZone = useCallback((_dropFiles, acceptedFiles) => {
    const file = acceptedFiles[0];
    if (file) {
      setUploadedFile(file);
      setUploadedPreview(window.URL.createObjectURL(file));
    }
  }, []);

  const handleGenerate = () => {
    setEditedListing(null);
    setShowComparison(false);

    if (uploadedFile) {
      const formData = new FormData();
      formData.append("intent", "generate");
      formData.append("uploadedImage", uploadedFile);
      fetcher.submit(formData, {
        method: "POST",
        encType: "multipart/form-data",
      });
    } else {
      fetcher.submit(
        {
          intent: "generate",
          imageUrl: product.images[0]?.url || "",
        },
        { method: "POST" },
      );
    }
  };

  const handlePush = () => {
    if (!current) return;
    fetcher.submit(
      {
        intent: "push",
        title: current.title,
        description: current.description,
        tags: current.tags.join(", "),
        seoTitle: current.seoTitle,
        seoDescription: current.seoDescription,
      },
      { method: "POST" },
    );
  };

  const updateField = (field, value) => {
    setEditedListing((prev) => ({ ...prev, [field]: value }));
  };

  const hasImage = product.images.length > 0 || uploadedFile;

  return (
    <Page
      backAction={{ onAction: () => navigate("/app") }}
      title={product.title}
      subtitle={`Status: ${product.status.toLowerCase()}`}
    >
      <Layout>
        {/* Left column: images + generate */}
        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Product Images
                </Text>
                {product.images.length > 0 && !uploadedPreview && (
                  <BlockStack gap="200">
                    {product.images.map((img, i) => (
                      <img
                        key={i}
                        src={img.url}
                        alt={img.alt}
                        style={{
                          width: "100%",
                          borderRadius: "8px",
                          border: "1px solid var(--p-color-border)",
                        }}
                      />
                    ))}
                  </BlockStack>
                )}

                {uploadedPreview && (
                  <BlockStack gap="200">
                    <img
                      src={uploadedPreview}
                      alt="Uploaded product"
                      style={{
                        width: "100%",
                        borderRadius: "8px",
                        border: "1px solid var(--p-color-border)",
                      }}
                    />
                    <Button
                      variant="plain"
                      onClick={() => {
                        setUploadedFile(null);
                        setUploadedPreview(null);
                      }}
                    >
                      Remove uploaded image
                    </Button>
                  </BlockStack>
                )}

                {!uploadedPreview && (
                  <DropZone
                    accept="image/*"
                    type="image"
                    onDrop={handleDropZone}
                    variableHeight
                  >
                    <DropZone.FileUpload
                      actionHint="or drop image to upload"
                      actionTitle="Upload photo"
                    />
                  </DropZone>
                )}
              </BlockStack>
            </Card>

            {!hasImage && (
              <Banner tone="warning">
                <p>
                  This product has no images. Upload a photo or add images in
                  Shopify admin to generate a listing.
                </p>
              </Banner>
            )}

            {!access.isPro && (
              <Card>
                <BlockStack gap="200">
                  <InlineStack align="space-between">
                    <Text variant="bodySm" tone="subdued">
                      Free generations this month
                    </Text>
                    <Text variant="bodySm" fontWeight="semibold">
                      {currentUsage} of {access.limit} used
                    </Text>
                  </InlineStack>
                  <ProgressBar
                    progress={(currentUsage / access.limit) * 100}
                    size="small"
                    tone={atLimit ? "critical" : "primary"}
                  />
                  {atLimit && (
                    <Text variant="bodySm" tone="critical">
                      Upgrade to Pro for unlimited generations
                    </Text>
                  )}
                </BlockStack>
              </Card>
            )}

            {access.isPro && (
              <InlineStack align="center">
                <Badge tone="success">Pro</Badge>
                <Text variant="bodySm" tone="subdued">
                  Unlimited generations
                </Text>
              </InlineStack>
            )}

            <Button
              variant="primary"
              size="large"
              fullWidth
              onClick={handleGenerate}
              loading={isGenerating}
              disabled={!hasImage || atLimit}
            >
              {atLimit ? "Upgrade to generate" : "Generate with Snaplist"}
            </Button>

            {atLimit && (
              <Button
                fullWidth
                onClick={() => navigate("/app/billing")}
              >
                Upgrade to Pro — $19/mo
              </Button>
            )}
          </BlockStack>
        </Layout.Section>

        {/* Right column: results */}
        <Layout.Section>
          <BlockStack gap="400">
            {error && (
              <Banner tone="critical" title="Error">
                <p>{error}</p>
              </Banner>
            )}

            {/* Post-push: celebrate and move on */}
            {pushed && (
              <Card>
                <BlockStack gap="400">
                  <Banner tone="success" title="Listing pushed to Shopify!">
                    <p>Your product listing has been updated.</p>
                  </Banner>
                  <InlineStack gap="300">
                    <Button
                      url={`shopify:admin/products/${product.numericId}`}
                      target="_blank"
                    >
                      View in admin
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => navigate("/app")}
                    >
                      Generate another product
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            )}

            {isGenerating && <GeneratingProgress />}

            {/* Generated listing: edit mode */}
            {current && !isGenerating && !pushed && !showComparison && (
              <>
                <Card>
                  <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">
                        Generated Listing
                      </Text>
                      <InlineStack gap="200">
                        <Button
                          onClick={() => setShowComparison(true)}
                          size="slim"
                        >
                          Compare before/after
                        </Button>
                        <Button
                          variant="primary"
                          onClick={handlePush}
                          loading={isPushing}
                        >
                          Push to Shopify
                        </Button>
                      </InlineStack>
                    </InlineStack>

                    <TextField
                      label="Title"
                      value={current.title}
                      onChange={(v) => updateField("title", v)}
                      autoComplete="off"
                    />

                    {/* Description: edit raw + preview rendered */}
                    <BlockStack gap="200">
                      <TextField
                        label="Description"
                        value={current.description}
                        onChange={(v) => updateField("description", v)}
                        multiline={6}
                        autoComplete="off"
                      />
                      <Box
                        padding="300"
                        background="bg-surface-secondary"
                        borderRadius="200"
                      >
                        <Text variant="bodySm" tone="subdued">
                          Preview
                        </Text>
                        <div
                          style={{ marginTop: "4px" }}
                          dangerouslySetInnerHTML={{
                            __html: current.description,
                          }}
                        />
                      </Box>
                    </BlockStack>

                    <BlockStack gap="200">
                      <Text as="h3" variant="headingSm">
                        Key Features
                      </Text>
                      {current.bullets.map((bullet, i) => (
                        <TextField
                          key={i}
                          label={`Bullet ${i + 1}`}
                          labelHidden
                          value={bullet}
                          onChange={(v) => {
                            const newBullets = [...current.bullets];
                            newBullets[i] = v;
                            updateField("bullets", newBullets);
                          }}
                          autoComplete="off"
                        />
                      ))}
                    </BlockStack>

                    <EditableTags
                      tags={current.tags}
                      onChange={(tags) => updateField("tags", tags)}
                    />
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">
                      SEO
                    </Text>
                    <TextField
                      label="SEO Title"
                      value={current.seoTitle}
                      onChange={(v) => updateField("seoTitle", v)}
                      autoComplete="off"
                      helpText={`${current.seoTitle.length}/60 characters`}
                    />
                    <TextField
                      label="SEO Description"
                      value={current.seoDescription}
                      onChange={(v) => updateField("seoDescription", v)}
                      multiline={2}
                      autoComplete="off"
                      helpText={`${current.seoDescription.length}/155 characters`}
                    />
                  </BlockStack>
                </Card>
              </>
            )}

            {/* Before/after comparison view */}
            {current && !isGenerating && !pushed && showComparison && (
              <>
                <Card>
                  <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">
                        Before / After
                      </Text>
                      <InlineStack gap="200">
                        <Button
                          onClick={() => setShowComparison(false)}
                          size="slim"
                        >
                          Back to editor
                        </Button>
                        <Button
                          variant="primary"
                          onClick={handlePush}
                          loading={isPushing}
                        >
                          Push to Shopify
                        </Button>
                      </InlineStack>
                    </InlineStack>

                    <ComparisonField
                      label="Title"
                      before={original.title}
                      after={current.title}
                    />

                    <Divider />

                    <ComparisonField
                      label="Description"
                      before={original.descriptionHtml}
                      after={current.description}
                    />

                    <Divider />

                    <BlockStack gap="100">
                      <Text variant="headingSm">Tags</Text>
                      <InlineStack gap="400" wrap={false}>
                        <Box width="50%">
                          <Text variant="bodySm" tone="subdued">
                            Before
                          </Text>
                          <InlineStack gap="100" wrap>
                            {original.tags.length > 0 ? (
                              original.tags.map((tag, i) => (
                                <Tag key={i}>{tag}</Tag>
                              ))
                            ) : (
                              <Text tone="subdued">No tags</Text>
                            )}
                          </InlineStack>
                        </Box>
                        <Box width="50%">
                          <Text variant="bodySm" tone="subdued">
                            After
                          </Text>
                          <InlineStack gap="100" wrap>
                            {current.tags.map((tag, i) => (
                              <Tag key={i}>{tag}</Tag>
                            ))}
                          </InlineStack>
                        </Box>
                      </InlineStack>
                    </BlockStack>

                    <Divider />

                    <ComparisonField
                      label="SEO Title"
                      before={original.seoTitle}
                      after={current.seoTitle}
                    />

                    <ComparisonField
                      label="SEO Description"
                      before={original.seoDescription}
                      after={current.seoDescription}
                    />
                  </BlockStack>
                </Card>
              </>
            )}

            {/* Current listing: no generation yet */}
            {!current && !isGenerating && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Current Listing
                  </Text>
                  <BlockStack gap="200">
                    <Text variant="headingSm">Title</Text>
                    <Text>{product.title}</Text>
                  </BlockStack>
                  {product.descriptionHtml ? (
                    <BlockStack gap="200">
                      <Text variant="headingSm">Description</Text>
                      <div
                        dangerouslySetInnerHTML={{
                          __html: product.descriptionHtml,
                        }}
                      />
                    </BlockStack>
                  ) : (
                    <Banner tone="info">
                      <p>
                        No description yet. Hit "Generate with Snaplist" to
                        create one!
                      </p>
                    </Banner>
                  )}
                  {product.tags.length > 0 && (
                    <BlockStack gap="200">
                      <Text variant="headingSm">Tags</Text>
                      <InlineStack gap="100">
                        {product.tags.map((tag, i) => (
                          <Tag key={i}>{tag}</Tag>
                        ))}
                      </InlineStack>
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
