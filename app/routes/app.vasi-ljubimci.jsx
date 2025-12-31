import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams, useFetcher, useRevalidator } from "@remix-run/react";
import { useCallback, useMemo, useEffect } from "react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  InlineStack,
  Pagination,
  EmptyState,
  Badge,
  Button,
  IndexTable,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

const ITEMS_PER_PAGE = 20;

async function fetchMetaobjects(admin, type, first, after, last, before) {
  const response = await admin.graphql(
    `#graphql
      query Metaobjects($type: String!, $first: Int, $after: String, $last: Int, $before: String) {
        metaobjects(type: $type, first: $first, after: $after, last: $last, before: $before) {
          edges {
            node {
              id
              handle
              type
              capabilities {
                publishable {
                  status
                }
              }
              fields {
                key
                value
                type
                reference {
                  ... on MediaImage {
                    id
                    image {
                      url
                      altText
                    }
                  }
                  ... on Metaobject {
                    id
                    handle
                    type
                  }
                }
              }
              updatedAt
            }
          }
          pageInfo {
            hasNextPage
            hasPreviousPage
            startCursor
            endCursor
          }
        }
      }
    `,
    {
      variables: {
        type,
        first: first || undefined,
        after: after || undefined,
        last: last || undefined,
        before: before || undefined,
      },
    },
  );

  const jsonRes = await response.json();
  const errors = jsonRes?.errors || [];
  const metaobjects = jsonRes?.data?.metaobjects || null;

  if (errors.length) {
    console.error("GraphQL errors:", errors);
    return { metaobjects: [], pageInfo: null, errors };
  }

  return {
    metaobjects: metaobjects?.edges?.map((edge) => edge.node) || [],
    pageInfo: metaobjects?.pageInfo || null,
    errors: [],
  };
}

async function updateMetaobjectStatus(admin, id, status) {
  // Update status through capabilities.publishable.status
  const response = await admin.graphql(
    `#graphql
      mutation MetaobjectUpdate($id: ID!, $metaobject: MetaobjectUpdateInput!) {
        metaobjectUpdate(id: $id, metaobject: $metaobject) {
          metaobject {
            id
            capabilities {
              publishable {
                status
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        id,
        metaobject: {
          capabilities: {
            publishable: {
              status: status,
            },
          },
        },
      },
    },
  );

  const jsonRes = await response.json();
  const errors = jsonRes?.errors || [];
  const userErrors = jsonRes?.data?.metaobjectUpdate?.userErrors || [];
  const metaobject = jsonRes?.data?.metaobjectUpdate?.metaobject || null;

  if (errors.length || userErrors.length) {
    return {
      success: false,
      errors: [...errors, ...userErrors].map((e) => e.message || e),
    };
  }

  return {
    success: true,
    metaobject,
  };
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") || null;
  const direction = url.searchParams.get("direction") || "next";

  try {
    // For backward pagination, use last and before
    const isPrevious = direction === "previous";
    const { metaobjects, pageInfo, errors } = await fetchMetaobjects(
      admin,
      "vasi_ljubimci",
      isPrevious ? undefined : ITEMS_PER_PAGE,
      isPrevious ? undefined : cursor || undefined,
      isPrevious ? ITEMS_PER_PAGE : undefined,
      isPrevious ? cursor || undefined : undefined,
    );

    if (errors.length) {
      return json(
        {
          metaobjects: [],
          pageInfo: null,
          error: errors.map((e) => e.message).join(", "),
        },
        { status: 500 },
      );
    }

    return json({
      metaobjects,
      pageInfo,
      error: null,
    });
  } catch (error) {
    console.error("Error fetching metaobjects:", error);
    return json(
      {
        metaobjects: [],
        pageInfo: null,
        error: error.message || "Failed to fetch metaobjects",
      },
      { status: 500 },
    );
  }
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const id = formData.get("id");
  const status = formData.get("status");

  if (!id || !status) {
    return json({ success: false, error: "Missing id or status" }, { status: 400 });
  }

  // Status should be "ACTIVE" or "DRAFT" (uppercase enum values)
  const statusEnum = status.toUpperCase() === "ACTIVE" ? "ACTIVE" : "DRAFT";

  try {
    const result = await updateMetaobjectStatus(admin, id, statusEnum);
    if (result.success) {
      return json({ success: true, metaobject: result.metaobject });
    } else {
      return json(
        { success: false, error: result.errors.join(", ") },
        { status: 400 },
      );
    }
  } catch (error) {
    console.error("Error updating metaobject status:", error);
    return json(
      { success: false, error: error.message || "Failed to update status" },
      { status: 500 },
    );
  }
};

function formatFieldValue(field) {
  if (!field) return "-";
  
  if (field.reference) {
    // Handle media/image references
    if (field.reference.image) {
      return field.reference.image.url || "-";
    }
    return "Reference";
  }

  if (field.type === "list.metaobject_reference" || field.type === "metaobject_reference") {
    return "Reference";
  }

  if (field.type === "date" || field.type === "date_time") {
    return field.value ? new Date(field.value).toLocaleDateString() : "-";
  }

  if (field.type === "number_integer" || field.type === "number_decimal") {
    return field.value || "-";
  }

  if (field.type === "boolean") {
    return field.value === "true" ? "Yes" : "No";
  }

  // Default: return the value as string
  return field.value || "-";
}

export default function VasiLjubimci() {
  const { metaobjects, pageInfo, error } = useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();

  const currentCursor = searchParams.get("cursor") || null;

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show("Status updated successfully");
      // Revalidate the loader data instead of full page reload
      revalidator.revalidate();
    } else if (fetcher.data?.error) {
      shopify.toast.show(`Failed to update status: ${fetcher.data.error}`, {
        isError: true,
      });
    }
  }, [fetcher.data, shopify, revalidator]);

  const handleStatusChange = useCallback(
    (id, newStatus) => {
      const formData = new FormData();
      formData.append("id", id);
      formData.append("status", newStatus);
      fetcher.submit(formData, { method: "post" });
    },
    [fetcher],
  );

  const handlePagination = useCallback(
    (direction) => {
      const newParams = new URLSearchParams();
      
      if (direction === "next" && pageInfo?.hasNextPage) {
        newParams.set("cursor", pageInfo.endCursor);
        newParams.set("direction", "next");
      } else if (direction === "previous" && pageInfo?.hasPreviousPage) {
        newParams.set("cursor", pageInfo.startCursor);
        newParams.set("direction", "previous");
      }
      // If no direction, we're on the first page, so no params needed

      setSearchParams(newParams);
    },
    [pageInfo, setSearchParams],
  );

  // Extract all unique field keys from metaobjects
  const fieldKeys = useMemo(() => {
    const keys = new Set();
    metaobjects.forEach((metaobject) => {
      metaobject.fields?.forEach((field) => {
        keys.add(field.key);
      });
    });
    return Array.from(keys).sort();
  }, [metaobjects]);

  // Build table rows with status and action
  const tableRows = useMemo(() => {
    return metaobjects.map((metaobject) => {
      // Get status from capabilities.publishable.status
      const status =
        metaobject.capabilities?.publishable?.status || "DRAFT";
      const isActive = status === "ACTIVE";

      const row = [
        metaobject.handle || metaobject.id.split("/").pop(),
      ];

      // Add values for each field key
      fieldKeys.forEach((key) => {
        const field = metaobject.fields?.find((f) => f.key === key);
        const value = formatFieldValue(field);
        row.push(value);
      });

      // Add updated date
      row.push(
        metaobject.updatedAt
          ? new Date(metaobject.updatedAt).toLocaleDateString()
          : "-",
      );

      // Store metaobject data for status display
      row.metaobject = metaobject;
      row.status = status;
      row.isActive = isActive;

      return row;
    });
  }, [metaobjects, fieldKeys]);

  const tableHeadings = ["Handle", ...fieldKeys, "Updated", "Status", "Action"];

  return (
    <Page>
      <TitleBar title="Vasi ljubimci" />
      <Card>
        <BlockStack gap="400">
          {error && (
            <Card>
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd" tone="critical">
                  Error: {error}
                </Text>
              </BlockStack>
            </Card>
          )}

          {metaobjects.length === 0 && !error ? (
            <EmptyState
              heading="No metaobject entries found"
              action={{
                content: "Refresh",
                onAction: () => window.location.reload(),
              }}
            >
              <Text as="p" variant="bodyMd">
                There are no entries for the "vasi_ljubimci" metaobject type.
              </Text>
            </EmptyState>
          ) : (
            <>
              <Text as="p" variant="bodyMd">
                Showing {metaobjects.length} metaobject entries of type "vasi_ljubimci"
              </Text>

              {tableRows.length > 0 && (
                <Card>
                  <IndexTable
                    resourceName={{ singular: "metaobject", plural: "metaobjects" }}
                    itemCount={tableRows.length}
                    headings={tableHeadings.map((heading, index) => ({
                      title: heading,
                    }))}
                    selectable={false}
                  >
                    {tableRows.map((row, rowIndex) => {
                      const metaobject = row.metaobject;
                      const status = row.status;
                      const isActive = row.isActive;
                      const newStatus = isActive ? "DRAFT" : "ACTIVE";
                      const isUpdating =
                        fetcher.state === "submitting" &&
                        fetcher.formData?.get("id") === metaobject.id;

                      // Extract data values (excluding metaobject property)
                      const dataValues = row.filter(
                        (val) => typeof val === "string" || typeof val === "number",
                      );

                      return (
                        <IndexTable.Row
                          id={metaobject.id}
                          key={metaobject.id}
                          position={rowIndex}
                        >
                          {dataValues.map((value, colIndex) => (
                            <IndexTable.Cell key={colIndex}>
                              <Text as="span" variant="bodyMd">
                                {value}
                              </Text>
                            </IndexTable.Cell>
                          ))}
                          <IndexTable.Cell>
                            <Badge tone={isActive ? "success" : "info"}>
                              {status}
                            </Badge>
                          </IndexTable.Cell>
                          <IndexTable.Cell>
                            <Button
                              size="micro"
                              onClick={() =>
                                handleStatusChange(metaobject.id, newStatus)
                              }
                              loading={isUpdating}
                              disabled={fetcher.state === "submitting"}
                            >
                              {isActive ? "Set to Draft" : "Set to Active"}
                            </Button>
                          </IndexTable.Cell>
                        </IndexTable.Row>
                      );
                    })}
                  </IndexTable>
                </Card>
              )}

              {pageInfo && (
                <InlineStack align="center">
                  <Pagination
                    hasPrevious={pageInfo.hasPreviousPage}
                    onPrevious={() => handlePagination("previous")}
                    hasNext={pageInfo.hasNextPage}
                    onNext={() => handlePagination("next")}
                  />
                </InlineStack>
              )}
            </>
          )}
        </BlockStack>
      </Card>
    </Page>
  );
}

