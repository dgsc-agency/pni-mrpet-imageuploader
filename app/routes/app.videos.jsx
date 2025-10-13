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

/* -------------------- SERVER -------------------- */

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  console.log("Video loader - shop:", session?.shop, "admin:", !!admin);
  return null;
};

function extractCustomIdFromFilename(filename) {
  const base = filename.split("/").pop() || filename;
  const withoutQuery = base.split("?")[0];
  const nameOnly = withoutQuery.includes(".")
    ? withoutQuery.substring(0, withoutQuery.lastIndexOf("."))
    : withoutQuery;
  return nameOnly.trim();
}

async function findProductByCustomId(admin, customId) {
  try {
    const response = await admin.graphql(
      `#graphql
        query FindProductByCustomId($identifier: ProductIdentifierInput!) {
          productByIdentifier(identifier: $identifier) { id title }
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

async function findProductAndVariantBySku(admin, sku) {
  const response = await admin.graphql(
    `#graphql
      query VariantBySku($query: String!) {
        productVariants(first: 1, query: $query) {
          edges { node { id title product { id title } } }
        }
      }
    `,
    { variables: { query: `sku:${sku}` } },
  );
  const resJson = await response.json();
  const edge = resJson?.data?.productVariants?.edges?.[0];
  if (!edge)
    return { productId: null, variantId: null, productTitle: null, variantTitle: null };
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
            resource: "VIDEO",
            filename,
            mimeType: mimeType || "video/mp4",
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
  for (const param of target.parameters) form.append(param.name, param.value);
  form.append("file", file, filename);
  const res = await fetch(target.url, { method: "POST", body: form });
  return res.ok;
}

async function createFileInShopify(admin, resourceUrl, filename) {
  const response = await admin.graphql(
    `#graphql
      mutation FileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files { __typename ... on Video { id fileStatus url } }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        files: [{ originalSource: resourceUrl, contentType: "VIDEO", alt: filename }],
      },
    },
  );
  const jsonRes = await response.json();
  const errors = jsonRes?.data?.fileCreate?.userErrors || [];
  const files = jsonRes?.data?.fileCreate?.files || [];
  return { files, errors };
}

async function waitForVideoReady(admin, videoId, { timeoutMs = 300000, intervalMs = 2000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await admin.graphql(
      `#graphql
        query MediaStatus($id: ID!) {
          node(id: $id) { id ... on Media { status } ... on Video { fileStatus } }
        }
      `,
      { variables: { id: videoId } },
    );
    const json = await res.json();
    const node = json?.data?.node;
    const status = node?.status || node?.fileStatus;
    if (status === "READY") return true;
    if (status === "FAILED") return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function listProductVideoMedia(admin, productId) {
  const response = await admin.graphql(
    `#graphql
      query ProductVideoMedia($id: ID!) {
        product(id: $id) {
          id
          media(first: 100) {
            edges { node { id __typename alt ... on Video { id } } }
          }
        }
      }
    `,
    { variables: { id: productId } },
  );
  const jsonRes = await response.json();
  const edges = jsonRes?.data?.product?.media?.edges || [];
  return edges.map((e) => e.node).filter((n) => n.__typename === "Video");
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

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  console.log("Video action - shop:", session?.shop);
  const formData = await request.formData();
  const files = formData.getAll("files");

  const results = [];

  for (const file of files) {
    try {
      if (!file || typeof file === "string" || !file.name) {
        results.push({ filename: String(file), status: "invalid_file" });
        continue;
      }

      const filename = file.name;
      const baseKey = extractCustomIdFromFilename(filename);

      let productId = null;
      let productTitle = null;
      const byCustom = await findProductByCustomId(admin, baseKey);
      if (byCustom?.productId) {
        productId = byCustom.productId;
        productTitle = byCustom.productTitle;
      } else {
        const bySku = await findProductAndVariantBySku(admin, baseKey);
        if (bySku?.productId) {
          productId = bySku.productId;
          productTitle = bySku.productTitle;
        }
      }
      if (!productId) {
        results.push({ filename, customId: baseKey, status: "no_product_for_custom_id_or_sku" });
        continue;
      }

      // delete existing videos with same alt/custom id
      const existingVideos = await listProductVideoMedia(admin, productId);
      const uploadedBaseName = (filename.split("/").pop() || filename).split("?")[0].toLowerCase();
      const toReplace = existingVideos.filter((video) => {
        const alt = (video.alt || "").trim().toLowerCase();
        return alt === baseKey.toLowerCase() || alt === uploadedBaseName;
      });
      let replacedCount = 0;
      if (toReplace.length) {
        const { deleted, errors: delErrors } = await deleteProductMedia(
          admin,
          productId,
          toReplace.map((v) => v.id),
        );
        replacedCount = deleted;
        if (delErrors?.length) {
          results.push({ filename, customId: baseKey, status: "delete_existing_failed", errors: delErrors });
          continue;
        }
      }

      // staged upload
      const { target, errors: stagedErrors } = await createStagedUpload(admin, {
        filename,
        mimeType: file.type,
        fileSize: file.size,
      });
      if (!target) {
        results.push({ filename, customId: baseKey, status: "staged_upload_error", errors: stagedErrors });
        continue;
      }

      const uploaded = await uploadToS3Target(target, file, filename);
      if (!uploaded) {
        results.push({ filename, customId: baseKey, status: "s3_upload_failed" });
        continue;
      }

      // create file in Shopify
      const { files: createdFiles, errors: fileErrors } = await createFileInShopify(
        admin,
        target.resourceUrl,
        filename,
      );
      if (fileErrors?.length) {
        results.push({ filename, customId: baseKey, status: "file_create_failed", errors: fileErrors });
        continue;
      }

      const created = createdFiles?.[0];
      const videoId = created?.id;
      if (!videoId) {
        results.push({ filename, customId: baseKey, status: "no_file_id_returned" });
        continue;
      }

      await waitForVideoReady(admin, videoId, { timeoutMs: 300000, intervalMs: 2000 });
      await new Promise((r) => setTimeout(r, 10000)); // ✅ buffer after READY

      const altText = productTitle || baseKey;

      // attach by originalSource instead of mediaId
      const attachRes = await admin.graphql(
        `#graphql
          mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
            productCreateMedia(productId: $productId, media: $media) {
              media { id alt mediaContentType status }
              mediaUserErrors { field message }
            }
          }
        `,
        {
          variables: {
            productId,
            media: [
              {
                originalSource: target.resourceUrl,
                mediaContentType: "VIDEO",
                alt: altText || null,
              },
            ],
          },
        },
      );

      const attachJson = await attachRes.json();
      const attachErrors = attachJson?.data?.productCreateMedia?.mediaUserErrors || [];
      const media = attachJson?.data?.productCreateMedia?.media || [];
      if (attachErrors?.length) {
        console.error("Attach failed", attachErrors);
        results.push({ filename, customId: baseKey, status: "attach_failed", errors: attachErrors });
        continue;
      }

      results.push({
        filename,
        customId: baseKey,
        status: replacedCount ? "replaced" : "ok",
        replaced: replacedCount,
        productId,
        media,
      });
    } catch (error) {
      const safeName = typeof file === "object" && file?.name ? file.name : String(file);
      const caughtCustomId = typeof safeName === "string" ? extractCustomIdFromFilename(safeName) : undefined;
      results.push({
        filename: safeName,
        customId: caughtCustomId,
        status: "error",
        message: error?.message,
      });
    }
  }

  return json({ results });
};

/* -------------------- CLIENT -------------------- */

export default function VideoUpload() {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [files, setFiles] = useState([]);
  const isSubmitting =
    ["loading", "submitting"].includes(fetcher.state) && fetcher.formMethod === "POST";

  const onDrop = useCallback((_dropFiles, acceptedFiles) => {
    setFiles((prev) => [...prev, ...acceptedFiles]);
  }, []);

  const removeFile = useCallback((index) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSubmit = useCallback(() => {
    if (!files.length || isSubmitting) return;
    const formData = new FormData();
    for (const file of files) formData.append("files", file, file.name);
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
        shopify.toast.show(`Uploaded ${summary.ok} videos successfully`);
      } else if (summary.ok > 0) {
        shopify.toast.show(`Uploaded ${summary.ok} videos, ${summary.failed} failed`);
      } else {
        shopify.toast.show(`All ${summary.failed} uploads failed`);
      }
    }
  }, [fetcher.data, shopify, summary.failed, summary.ok]);

  return (
    <Page>
      <TitleBar title="Video upload" />
      <Card>
        <BlockStack gap="300">
          <Text as="p" variant="bodyMd">
            Select video files. The filename must contain the product's custom ID (from metafield custom.id).
          </Text>
          <DropZone accept="video/*" allowMultiple onDrop={onDrop}>
            <DropZone.FileUpload actionTitle="Add videos" actionHint="or drop to upload" />
          </DropZone>

          {files.length ? (
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">Selected files</Text>
                <List>
                  {files.map((f, i) => (
                    <List.Item key={`${f.name}-${i}`}>
                      <InlineStack align="space-between">
                        <span><code>{f.name}</code></span>
                        <Button onClick={() => removeFile(i)} variant="tertiary">Remove</Button>
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
                headings={["File", "Custom ID", "Status"]}
                rows={(fetcher.data.results || []).map((r) => [
                  r.filename || r.productId || "Product",
                  r.customId || "-",
                  r.status +
                    (r.message ? `: ${r.message}` : "") +
                    (r.details ? ` (${JSON.stringify(r.details)})` : ""),
                ])}
              />
            </BlockStack>
          ) : null}
        </BlockStack>
      </Card>
    </Page>
  );
}