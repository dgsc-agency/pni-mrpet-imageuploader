import { useFetcher } from "@remix-run/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  InlineStack,
  Button,
  DropZone,
  List,
  DataTable,
  Banner,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  return null;
};

function extractSkuAndIndexFromFilename(filename) {
  // Convention: 1234 -> featured (index 0), 1234_1 -> second (index 1), 1234_2 -> third, ...
  const base = filename.split("/").pop() || filename;
  const withoutQuery = base.split("?")[0];
  const nameOnly = (withoutQuery.includes("."))
    ? withoutQuery.substring(0, withoutQuery.lastIndexOf("."))
    : withoutQuery;
  const match = nameOnly.match(/^(.*?)(?:_(\d+))?$/);
  if (!match) {
    return { sku: nameOnly.trim(), index: 0 };
  }
  const sku = (match[1] || "").trim();
  const index = match[2] ? parseInt(match[2], 10) : 0;
  return { sku, index: Number.isFinite(index) ? index : 0 };
}

async function findProductIdBySku(admin, sku) {
  const response = await admin.graphql(
    `#graphql
      query VariantBySku($query: String!) {
        productVariants(first: 1, query: $query) {
          edges {
            node {
              id
              sku
              product { id title }
            }
          }
        }
      }
    `,
    { variables: { query: `sku:${sku}` } },
  );
  const resJson = await response.json();
  const edge = resJson?.data?.productVariants?.edges?.[0];
  return edge?.node?.product?.id || null;
}

// Look up a product by custom.id metafield using productByIdentifier
async function findProductByCustomId(admin, customId) {
  try {
    const response = await admin.graphql(
      `#graphql
        query FindProductByCustomId($identifier: ProductIdentifierInput!) {
          productByIdentifier(identifier: $identifier) {
            id
            title
          }
        }
      `,
      {
        variables: {
          identifier: {
            customId: { namespace: "custom", key: "id", value: customId },
          },
        },
      },
    );
    const resJson = await response.json();
    const product = resJson?.data?.productByIdentifier;
    if (!product) return null;
    return { productId: product.id, productTitle: product.title };
  } catch (error) {
    console.log("Product custom.id lookup failed:", error);
    return null;
  }
}

// Find product/variant by SKU; returns ids and titles
async function findProductAndVariantBySku(admin, sku) {
  const response = await admin.graphql(
    `#graphql
      query VariantBySku($query: String!) {
        productVariants(first: 1, query: $query) {
          edges {
            node {
              id
              title
              product { id title }
            }
          }
        }
      }
    `,
    { variables: { query: `sku:${sku}` } },
  );
  const resJson = await response.json();
  const edge = resJson?.data?.productVariants?.edges?.[0];
  if (!edge) return { productId: null, variantId: null, productTitle: null, variantTitle: null };
  return {
    productId: edge.node.product.id,
    variantId: edge.node.id,
    productTitle: edge.node.product.title,
    variantTitle: edge.node.title,
  };
}

async function createStagedUpload(admin, { filename, mimeType, fileSize }) {
  const response = await admin.graphql(
    `#graphql
      mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets { url resourceUrl parameters { name value } }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        input: [
          {
            resource: "IMAGE",
            filename,
            mimeType: mimeType || "image/jpeg",
            fileSize: String(fileSize ?? 0),
            httpMethod: "POST",
          },
        ],
      },
    },
  );
  const jsonRes = await response.json();
  const errors = jsonRes?.data?.stagedUploadsCreate?.userErrors || [];
  const target = jsonRes?.data?.stagedUploadsCreate?.stagedTargets?.[0];
  return { target, errors };
}

async function uploadToS3Target(target, file, filename) {
  const form = new FormData();
  for (const param of target.parameters) {
    form.append(param.name, param.value);
  }
  form.append("file", file, filename);
  const res = await fetch(target.url, { method: "POST", body: form });
  return res.ok;
}

async function attachImageToProduct(admin, productId, resourceUrl, altText) {
  const response = await admin.graphql(
    `#graphql
      mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media {
            ... on MediaImage { id alt image { originalSrc } }
          }
          mediaUserErrors { field message }
        }
      }
    `,
    {
      variables: {
        productId,
        media: [
          {
            alt: altText || null,
            originalSource: resourceUrl,
            mediaContentType: "IMAGE",
          },
        ],
      },
    },
  );
  const jsonRes = await response.json();
  const errors = jsonRes?.data?.productCreateMedia?.mediaUserErrors || [];
  const media = jsonRes?.data?.productCreateMedia?.media || [];
  return { media, errors };
}

async function listProductImageMedia(admin, productId) {
  const response = await admin.graphql(
    `#graphql
      query ProductImageMedia($id: ID!) {
        product(id: $id) {
          id
          media(first: 100) {
            edges {
              node {
                id
                __typename
                ... on MediaImage {
                  id
                  alt
                  image { originalSrc }
                }
              }
            }
          }
        }
      }
    `,
    { variables: { id: productId } },
  );
  const jsonRes = await response.json();
  const edges = jsonRes?.data?.product?.media?.edges || [];
  return edges.map((e) => e.node).filter((n) => n.__typename === "MediaImage");
}

async function deleteProductMedia(admin, productId, mediaIds) {
  if (!mediaIds.length) return { deleted: 0, errors: [] };
  const response = await admin.graphql(
    `#graphql
      mutation ProductDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
        productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
          deletedMediaIds
          userErrors { field message }
        }
      }
    `,
    { variables: { productId, mediaIds } },
  );
  const jsonRes = await response.json();
  const errors = jsonRes?.data?.productDeleteMedia?.userErrors || [];
  const deleted = jsonRes?.data?.productDeleteMedia?.deletedMediaIds?.length || 0;
  return { deleted, errors };
}

async function listVariantMedia(admin, variantId) {
  const response = await admin.graphql(
    `#graphql
      query VariantMedia($id: ID!) {
        productVariant(id: $id) {
          id
          media(first: 50) { nodes { id } }
        }
      }
    `,
    { variables: { id: variantId } },
  );
  const jsonRes = await response.json();
  return jsonRes?.data?.productVariant?.media?.nodes?.map((n) => n.id) || [];
}

async function detachVariantMedia(admin, variantId, mediaIds) {
  if (!mediaIds.length) return { removed: 0, errors: [] };
  const response = await admin.graphql(
    `#graphql
      mutation ProductVariantDetachMedia($variantId: ID!, $mediaIds: [ID!]!) {
        productVariantDetachMedia(variantId: $variantId, mediaIds: $mediaIds) {
          detachedMediaIds
          userErrors { field message }
        }
      }
    `,
    { variables: { variantId, mediaIds } },
  );
  const jsonRes = await response.json();
  const errors = jsonRes?.data?.productVariantDetachMedia?.userErrors || [];
  const removed = jsonRes?.data?.productVariantDetachMedia?.detachedMediaIds?.length || 0;
  return { removed, errors };
}

async function appendVariantMedia(admin, variantId, mediaId) {
  const response = await admin.graphql(
    `#graphql
      mutation ProductVariantAppendMedia($variantId: ID!, $mediaIds: [ID!]!) {
        productVariantAppendMedia(variantId: $variantId, mediaIds: $mediaIds) {
          attachedToVariantIds
          userErrors { field message }
        }
      }
    `,
    { variables: { variantId, mediaIds: [mediaId] } },
  );
  const jsonRes = await response.json();
  const errors = jsonRes?.data?.productVariantAppendMedia?.userErrors || [];
  return { errors };
}

async function waitForMediaReady(admin, mediaId, { timeoutMs = 15000, intervalMs = 600 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await admin.graphql(
      `#graphql
        query MediaStatus($id: ID!) {
          node(id: $id) {
            ... on Media { id status }
          }
        }
      `,
      { variables: { id: mediaId } },
    );
    const json = await res.json();
    const status = json?.data?.node?.status;
    if (status === "READY") return true;
    // SMALL BACKOFF
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function bulkSetVariantMedia(admin, productId, variantId, mediaId) {
  const response = await admin.graphql(
    `#graphql
      mutation VariantSetMedia($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        productId,
        variants: [
          {
            id: variantId,
            mediaId,
          },
        ],
      },
    },
  );
  const json = await response.json();
  const errors = json?.data?.productVariantsBulkUpdate?.userErrors || [];
  return { errors };
}

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const files = formData.getAll("files");

  const results = [];
  const productIdToCreated = new Map(); // productId -> Array<{id, order}>

  for (const file of files) {
    try {
      if (!file || typeof file === "string" || !file.name) {
        results.push({ filename: String(file), status: "invalid_file" });
        continue;
      }

      const filename = file.name;
      const { sku, index } = extractSkuAndIndexFromFilename(filename);
      const uploadedBaseName = (filename.split("/").pop() || filename).split("?")[0].toLowerCase();
      const altLabel = index === 0 ? sku : `${sku}_${index}`;

      // 1) Try product by custom.id (using base filename as the custom id)
      const productMatch = await findProductByCustomId(admin, sku);
      let productId = null;
      let productTitle = null;
      let variantId = null;
      let variantTitle = null;
      let isProductLevel = false;

      if (productMatch?.productId) {
        productId = productMatch.productId;
        productTitle = productMatch.productTitle;
        isProductLevel = true;
      } else {
        // 2) Fallback: find by variant SKU
        const variantMatch = await findProductAndVariantBySku(admin, sku);
        productId = variantMatch.productId;
        variantId = variantMatch.variantId;
        productTitle = variantMatch.productTitle;
        variantTitle = variantMatch.variantTitle;
      }

      if (!productId) {
        results.push({ filename, sku, status: "no_product_for_sku" });
        continue;
      }

      // Check existing images on product; match by exact alt label OR filename equality
      const existingImages = await listProductImageMedia(admin, productId);
      const toReplace = existingImages.filter((img) => {
        const alt = (img.alt || "").trim().toLowerCase();
        const src = img?.image?.url || img?.image?.originalSrc || "";
        const existingBaseName = (src.split("/").pop() || "").split("?")[0].toLowerCase();
        return alt === altLabel.toLowerCase() || (!!existingBaseName && existingBaseName === uploadedBaseName);
      });
      let replacedCount = 0;
      if (toReplace.length) {
        const { deleted, errors: delErrors } = await deleteProductMedia(
          admin,
          productId,
          toReplace.map((i) => i.id),
        );
        replacedCount = deleted;
        if (delErrors?.length) {
          results.push({ filename, sku, status: "delete_existing_failed", errors: delErrors });
          continue;
        }
      }

      const { target, errors: stagedErrors } = await createStagedUpload(admin, {
        filename,
        mimeType: file.type,
        fileSize: file.size,
      });
      if (!target) {
        results.push({ filename, sku, status: "staged_upload_error", errors: stagedErrors });
        continue;
      }

      const uploaded = await uploadToS3Target(target, file, filename);
      if (!uploaded) {
        results.push({ filename, sku, status: "s3_upload_failed" });
        continue;
      }

      // Alt text: Product - Variant when variantTitle exists; else product title; fallback to altLabel
      let altText = altLabel;
      if (productTitle && variantTitle) {
        altText = `${productTitle} - ${variantTitle}`;
        if (index > 0) altText += ` (${index + 1})`;
      } else if (productTitle) {
        altText = productTitle;
        if (!isProductLevel && index > 0) altText += ` (${index + 1})`;
      }

      const { media, errors: attachErrors } = await attachImageToProduct(
        admin,
        productId,
        target.resourceUrl,
        altText,
      );
      if (attachErrors?.length) {
        results.push({ filename, sku, status: "attach_failed", errors: attachErrors });
        continue;
      }

      const createdId = media?.[0]?.id || null;
      if (createdId) {
        const list = productIdToCreated.get(productId) || [];
        list.push({ id: createdId, order: index, isProductLevel });
        productIdToCreated.set(productId, list);
      }
      // Assign variant image only when matched by SKU
      if (variantId && createdId && !isProductLevel) {
        try {
          const ready = await waitForMediaReady(admin, createdId);
          if (!ready) {
            results.push({ filename, sku, status: "media_not_ready", productId, media });
          } else {
            // Prefer new API via bulk update
            const { errors: bulkErrors } = await bulkSetVariantMedia(admin, productId, variantId, createdId);
            if (bulkErrors?.length) {
              // Fallback to detach/append
              const existingVariantMedia = await listVariantMedia(admin, variantId);
              if (existingVariantMedia.length) {
                const { errors: detErrors } = await detachVariantMedia(admin, variantId, existingVariantMedia);
                if (detErrors?.length) {
                  results.push({ filename, sku, status: "variant_detach_failed", errors: detErrors });
                }
              }
              const { errors: appErrors } = await appendVariantMedia(admin, variantId, createdId);
              if (appErrors?.length) {
                results.push({ filename, sku, status: "variant_attach_failed", errors: appErrors });
              }
            }
          }
        } catch (variantError) {
          results.push({ filename, sku, status: "variant_error", message: variantError?.message });
        }
      }
      // Always record the successful product upload
      results.push({ filename, sku, status: replacedCount ? "replaced" : "ok", replaced: replacedCount, productId, media, order: index });
    } catch (error) {
      const safeName = typeof file === "object" && file?.name ? file.name : String(file);
      const { sku: caughtSku } = typeof safeName === "string" ? extractSkuAndIndexFromFilename(safeName) : { sku: undefined };
      results.push({ filename: safeName, sku: caughtSku, status: "error", message: error?.message });
    }
  }

  // After all uploads, reorder only if this batch included a featured (index 0) image for the product.
  for (const [productId, created] of productIdToCreated.entries()) {
    // Partition: product-level vs variant-level created in this batch
    const productLevel = created.filter((c) => c.isProductLevel);
    const variantLevel = created.filter((c) => !c.isProductLevel);
    if (!productLevel.length) continue;

    // Ensure all newly created media are READY before attempting reorder
    try {
      await Promise.all(
        created.map(async (m) => {
          try {
            await waitForMediaReady(admin, m.id, { timeoutMs: 20000, intervalMs: 800 });
          } catch (_) {}
        }),
      );
    } catch (_) {}

    productLevel.sort((a, b) => a.order - b.order);
    variantLevel.sort((a, b) => a.order - b.order);

    // Build a comprehensive order including existing media so Admin shows the true first item
    const existingIds = await listAllProductMediaIds(admin, productId);
    const createdIdsInOrder = [
      ...productLevel.map((m) => m.id),
      ...variantLevel.map((m) => m.id),
    ];
    const remainingExisting = existingIds.filter((id) => !createdIdsInOrder.includes(id));
    const finalOrder = [
      ...productLevel.map((m) => m.id),
      ...remainingExisting,
      ...variantLevel.map((m) => m.id),
    ];
    const moves = finalOrder.map((id, index) => ({ id, newPosition: String(index + 1) }));

    // Debug: log what we're trying to reorder
    console.log(`Reordering product ${productId} (product first, variants after):`, moves);

    // Add a small delay to ensure media is ready for reordering
    await new Promise(resolve => setTimeout(resolve, 1000));

    const reorderResult = await reorderProductMedia(admin, productId, moves);
    if (!reorderResult.success) {
      results.push({ 
        productId, 
        status: "reorder_failed", 
        message: reorderResult.message,
        details: reorderResult.errors 
      });
    }
  }

  return json({ results });
};

async function reorderProductMedia(admin, productId, moves) {
  if (!moves?.length) return { success: true };
  const response = await admin.graphql(
    `#graphql
      mutation ProductReorderMedia($id: ID!, $moves: [MoveInput!]!) {
        productReorderMedia(id: $id, moves: $moves) {
          userErrors { field message }
        }
      }
    `,
    { variables: { id: productId, moves } },
  );
  const resJson = await response.json();
  const errors = resJson?.data?.productReorderMedia?.userErrors || [];
  if (errors.length) {
    const msg = errors.map((e) => e.message).join(", ");
    return { success: false, errors, message: msg };
  }
  return { success: true };
}

async function listAllProductMediaIds(admin, productId) {
  const response = await admin.graphql(
    `#graphql
      query AllProductMediaIds($id: ID!) {
        product(id: $id) {
          id
          media(first: 250) {
            nodes { id }
          }
        }
      }
    `,
    { variables: { id: productId } },
  );
  const json = await response.json();
  return json?.data?.product?.media?.nodes?.map((n) => n.id) || [];
}

export default function BulkUpload() {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [files, setFiles] = useState([]);
  const isSubmitting =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  const onDrop = useCallback((_dropFiles, acceptedFiles) => {
    setFiles((prev) => [...prev, ...acceptedFiles]);
  }, []);

  const removeFile = useCallback((index) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSubmit = useCallback(() => {
    if (!files.length || isSubmitting) return;
    const formData = new FormData();
    for (const file of files) {
      formData.append("files", file, file.name);
    }
    fetcher.submit(formData, { method: "post", encType: "multipart/form-data" });
  }, [files, fetcher, isSubmitting]);

  const summary = useMemo(() => {
    const results = fetcher.data?.results || [];
    const ok = results.filter((r) => r.status === "ok" || r.status === "replaced").length;
    const failed = results.filter((r) => !["ok", "replaced"].includes(r.status)).length;
    return { total: results.length, ok, failed };
  }, [fetcher.data]);

  useEffect(() => {
    if ((fetcher.data?.results || []).length) {
      if (summary.failed === 0) {
        shopify.toast.show(`Uploaded ${summary.ok} images successfully`);
      } else if (summary.ok > 0) {
        shopify.toast.show(
          `Uploaded ${summary.ok} images, ${summary.failed} failed`,
        );
      } else {
        shopify.toast.show(`All ${summary.failed} uploads failed`);
      }
    }
  }, [fetcher.data, shopify, summary.failed, summary.ok]);

  return (
    <Page>
      <TitleBar title="Bulk image upload" />
      <Card>
        <BlockStack gap="300">
          <Text as="p" variant="bodyMd">
            Select multiple image files. The SKU must be the filename (without extension).
          </Text>
          <DropZone accept="image/*" allowMultiple onDrop={onDrop}>
            <DropZone.FileUpload actionTitle="Add images" actionHint="or drop to upload" />
          </DropZone>
          {files.length ? (
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">Selected files</Text>
                <List>
                  {files.map((f, i) => (
                    <List.Item key={`${f.name}-${i}`}>
                      <InlineStack align="space-between">
                        <span>
                          <code>{f.name}</code>
                        </span>
                        <Button onClick={() => removeFile(i)} variant="tertiary">
                          Remove
                        </Button>
                      </InlineStack>
                    </List.Item>
                  ))}
                </List>
              </BlockStack>
            </Card>
          ) : null}
          <InlineStack gap="200">
            <Button loading={isSubmitting} disabled={!files.length} onClick={handleSubmit}>
              Upload
            </Button>
            <Button disabled={!files.length || isSubmitting} onClick={() => setFiles([])} variant="secondary">
              Clear
            </Button>
          </InlineStack>
          {(fetcher.data?.results || []).length ? (
            <BlockStack gap="200">
              {summary.failed ? (
                <Banner title="Some uploads failed" tone="critical" />
              ) : (
                <Banner title="Uploads completed" tone="success" />
              )}
              <DataTable
                columnContentTypes={["text", "text", "text"]}
                headings={["File", "SKU", "Status"]}
                rows={(fetcher.data.results || []).map((r) => [
                  r.filename || r.productId || "Product",
                  r.sku || "-",
                  r.status + (r.message ? `: ${r.message}` : "") + (r.details ? ` (${JSON.stringify(r.details)})` : ""),
                ])}
              />
            </BlockStack>
          ) : null}
        </BlockStack>
      </Card>
    </Page>
  );
}

