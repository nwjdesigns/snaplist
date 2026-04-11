import { useState, useCallback } from "react";
import { useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { json } from "@remix-run/node";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  InlineStack,
  Thumbnail,
  Icon,
  ResourceList,
  ResourceItem,
  EmptyState,
  Badge,
  Banner,
  Filters,
  ChoiceList,
  Pagination,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { ImageIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { isFirstGeneration, checkGenerationAccess } from "../services/billing.server";

const PAGE_SIZE = 25;

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);

  const search = url.searchParams.get("search") || "";
  const cursor = url.searchParams.get("cursor") || null;
  const direction = url.searchParams.get("direction") || "forward";

  const query = search ? `title:*${search}*` : null;
  const isBackward = direction === "backward";

  const variables = {
    query,
    first: isBackward ? null : PAGE_SIZE,
    last: isBackward ? PAGE_SIZE : null,
    before: isBackward ? cursor : null,
    after: isBackward ? null : cursor,
  };

  const response = await admin.graphql(
    `#graphql
    query getProducts($query: String, $first: Int, $last: Int, $before: String, $after: String) {
      products(first: $first, last: $last, before: $before, after: $after, sortKey: UPDATED_AT, reverse: true, query: $query) {
        edges {
          node {
            id
            title
            status
            featuredImage {
              url
              altText
            }
            description
            totalInventory
          }
          cursor
        }
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
      }
    }`,
    { variables },
  );

  const data = await response.json();
  const { edges, pageInfo } = data.data.products;

  const products = edges
    .map(({ node }) => ({
      id: node.id,
      numericId: node.id.replace("gid://shopify/Product/", ""),
      title: node.title,
      status: node.status,
      image: node.featuredImage?.url || null,
      imageAlt: node.featuredImage?.altText || node.title,
      hasDescription: !!node.description && node.description.trim().length > 0,
      inventory: node.totalInventory,
    }))
    .sort((a, b) => a.hasDescription - b.hasDescription);

  const [isNew, access] = await Promise.all([
    isFirstGeneration(session.shop),
    checkGenerationAccess(admin, session.shop),
  ]);

  return json({
    products,
    pageInfo,
    search,
    isNew,
    access,
  });
};

export default function Index() {
  const { products, pageInfo, search: initialSearch, isNew, access } = useLoaderData();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [searchValue, setSearchValue] = useState(initialSearch);
  const [statusFilter, setStatusFilter] = useState([]);
  const [descriptionFilter, setDescriptionFilter] = useState([]);

  const handleSearchChange = useCallback((value) => {
    setSearchValue(value);
  }, []);

  const handleSearchClear = useCallback(() => {
    setSearchValue("");
    setSearchParams({});
  }, [setSearchParams]);

  const handleSearchSubmit = useCallback(() => {
    const params = new URLSearchParams();
    if (searchValue) params.set("search", searchValue);
    setSearchParams(params);
  }, [searchValue, setSearchParams]);

  const handleNextPage = useCallback(() => {
    const params = new URLSearchParams(searchParams);
    params.set("cursor", pageInfo.endCursor);
    params.set("direction", "forward");
    setSearchParams(params);
  }, [searchParams, pageInfo, setSearchParams]);

  const handlePreviousPage = useCallback(() => {
    const params = new URLSearchParams(searchParams);
    params.set("cursor", pageInfo.startCursor);
    params.set("direction", "backward");
    setSearchParams(params);
  }, [searchParams, pageInfo, setSearchParams]);

  // Client-side filters for status and description
  let filteredProducts = products;
  if (statusFilter.length > 0) {
    filteredProducts = filteredProducts.filter((p) =>
      statusFilter.includes(p.status),
    );
  }
  if (descriptionFilter.length > 0) {
    if (descriptionFilter.includes("missing")) {
      filteredProducts = filteredProducts.filter((p) => !p.hasDescription);
    }
    if (descriptionFilter.includes("has")) {
      filteredProducts = filteredProducts.filter((p) => p.hasDescription);
    }
  }

  const filters = [
    {
      key: "status",
      label: "Status",
      filter: (
        <ChoiceList
          title="Status"
          titleHidden
          choices={[
            { label: "Active", value: "ACTIVE" },
            { label: "Draft", value: "DRAFT" },
            { label: "Archived", value: "ARCHIVED" },
          ]}
          selected={statusFilter}
          onChange={setStatusFilter}
          allowMultiple
        />
      ),
      shortcut: true,
    },
    {
      key: "description",
      label: "Description",
      filter: (
        <ChoiceList
          title="Description"
          titleHidden
          choices={[
            { label: "Missing description", value: "missing" },
            { label: "Has description", value: "has" },
          ]}
          selected={descriptionFilter}
          onChange={setDescriptionFilter}
        />
      ),
      shortcut: true,
    },
  ];

  const appliedFilters = [];
  if (statusFilter.length > 0) {
    appliedFilters.push({
      key: "status",
      label: `Status: ${statusFilter.map((s) => s.toLowerCase()).join(", ")}`,
      onRemove: () => setStatusFilter([]),
    });
  }
  if (descriptionFilter.length > 0) {
    appliedFilters.push({
      key: "description",
      label:
        descriptionFilter[0] === "missing"
          ? "Missing description"
          : "Has description",
      onRemove: () => setDescriptionFilter([]),
    });
  }

  const missingCount = products.filter((p) => !p.hasDescription).length;

  return (
    <Page>
      <TitleBar title="Snaplist" />
      <BlockStack gap="500">
        {isNew && (
          <Layout>
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingLg">
                    Welcome to Snaplist
                  </Text>
                  <Text variant="bodyMd">
                    Pick any product below and generate a professional listing in 30 seconds.
                    Snaplist will analyze the product photo and write your title, description, tags, and SEO — ready to push live.
                  </Text>
                  <Text variant="bodySm" tone="subdued">
                    {access.isPro
                      ? "You're on the Pro plan — unlimited generations."
                      : `You have ${access.limit - access.usage} free generations this month.`}
                  </Text>
                </BlockStack>
              </Card>
            </Layout.Section>
          </Layout>
        )}
        {missingCount > 0 && (
          <Layout>
            <Layout.Section>
              <Banner tone="warning" title={`${missingCount} products need descriptions`}>
                <p>
                  Use the "Description" filter to find products missing
                  descriptions and generate them with Snaplist.
                </p>
              </Banner>
            </Layout.Section>
          </Layout>
        )}
        <Layout>
          <Layout.Section>
            <Card padding="0">
              {products.length === 0 && !initialSearch ? (
                <EmptyState
                  heading="No products yet"
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>
                    Add products to your store, then come back here to generate
                    optimized listings with Snaplist.
                  </p>
                </EmptyState>
              ) : (
                <ResourceList
                  resourceName={{ singular: "product", plural: "products" }}
                  items={filteredProducts}
                  filterControl={
                    <Filters
                      queryValue={searchValue}
                      queryPlaceholder="Search products..."
                      onQueryChange={handleSearchChange}
                      onQueryClear={handleSearchClear}
                      onQueryFocus={() => {}}
                      filters={filters}
                      appliedFilters={appliedFilters}
                      onClearAll={() => {
                        setStatusFilter([]);
                        setDescriptionFilter([]);
                        handleSearchClear();
                      }}
                    />
                  }
                  renderItem={(product) => (
                    <ResourceItem
                      id={product.id}
                      media={
                        product.image ? (
                          <Thumbnail
                            source={product.image}
                            alt={product.imageAlt}
                            size="medium"
                          />
                        ) : (
                          <div
                            style={{
                              width: "60px",
                              height: "60px",
                              borderRadius: "8px",
                              background: "var(--p-color-bg-fill-secondary)",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            <Icon source={ImageIcon} tone="subdued" />
                          </div>
                        )
                      }
                      onClick={() =>
                        navigate(`/app/product/${product.numericId}`)
                      }
                    >
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="100">
                          <Text variant="bodyMd" fontWeight="bold">
                            {product.title}
                          </Text>
                          <InlineStack gap="200">
                            <Badge
                              tone={
                                product.status === "ACTIVE"
                                  ? "success"
                                  : undefined
                              }
                            >
                              {product.status.toLowerCase()}
                            </Badge>
                            {!product.hasDescription && (
                              <Badge tone="warning">missing description</Badge>
                            )}
                            {!product.image && (
                              <Badge tone="attention">no image</Badge>
                            )}
                          </InlineStack>
                        </BlockStack>
                      </InlineStack>
                    </ResourceItem>
                  )}
                />
              )}
              {(pageInfo.hasNextPage || pageInfo.hasPreviousPage) && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "center",
                    padding: "16px",
                  }}
                >
                  <Pagination
                    hasPrevious={pageInfo.hasPreviousPage}
                    hasNext={pageInfo.hasNextPage}
                    onPrevious={handlePreviousPage}
                    onNext={handleNextPage}
                  />
                </div>
              )}
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
