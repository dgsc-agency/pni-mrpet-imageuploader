import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
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
  TextField,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  return json({ shop: session?.shop });
};

// Helper functions for direct upload
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
  for (const param of target.parameters) {
    form.append(param.name, param.value);
  }
  form.append("file", file, filename);
  const res = await fetch(target.url, { method: "POST", body: form });
  return res.ok;
}

async function createFileInShopify(admin, resourceUrl, filename) {
  const response = await admin.graphql(
    `#graphql
      mutation FileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            id
            fileStatus
            preview {
              image {
                url
              }
            }
          }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        files: [
          {
            originalSource: resourceUrl,
            contentType: "VIDEO",
            alt: filename,
          },
        ],
      },
    },
  );
  const jsonRes = await response.json();
  const errors = jsonRes?.data?.fileCreate?.userErrors || [];
  const files = jsonRes?.data?.fileCreate?.files || [];
  return { files, errors };
}

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

async function attachVideoToProduct(admin, productId, fileId, altText) {
  const response = await admin.graphql(
    `#graphql
      mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media {
            ... on Media { id alt }
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
            mediaId: fileId,
            alt: altText || null,
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

// Get staged upload URL without processing the file
export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const filename = formData.get("filename");
  const mimeType = formData.get("mimeType");
  const fileSize = formData.get("fileSize");
  const customIds = formData.get("customIds") || "";

  if (!filename || !mimeType || !fileSize) {
    return json({ success: false, error: "Missing file information" });
  }

  const idList = customIds.split(";").map(s => s.trim()).filter(s => !!s);
  if (idList.length === 0) {
    return json({ success: false, error: "No custom IDs provided" });
  }

  try {
    // Only create staged upload URL - don't process the file
    const { target, errors: stagedErrors } = await createStagedUpload(admin, {
      filename,
      mimeType,
      fileSize: parseInt(fileSize),
    });

    if (!target) {
      return json({ success: false, error: "Staged upload failed", errors: stagedErrors });
    }

    return json({ 
      success: true, 
      uploadUrl: target.url,
      resourceUrl: target.resourceUrl,
      parameters: target.parameters,
      customIds: idList
    });
  } catch (error) {
    return json({ success: false, error: error.message });
  }
};

export default function DirectUpload() {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [file, setFile] = useState(null);
  const [customIds, setCustomIds] = useState("");
  const isSubmitting = ["loading", "submitting"].includes(fetcher.state) && fetcher.formMethod === "POST";

  const onDrop = useCallback((_dropFiles, acceptedFiles) => {
    if (acceptedFiles.length > 0) {
      setFile(acceptedFiles[0]);
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!file || !customIds.trim() || isSubmitting) return;
    
    try {
      // Step 1: Get staged upload URL (no file data sent)
      const formData = new FormData();
      formData.append("filename", file.name);
      formData.append("mimeType", file.type);
      formData.append("fileSize", file.size.toString());
      formData.append("customIds", customIds);
      
      const response = await fetch("/app/direct-upload", {
        method: "POST",
        body: formData,
      });
      
      const uploadData = await response.json();
      
      if (!uploadData.success) {
        shopify.toast.show(`Upload failed: ${uploadData.error}`, { isError: true });
        return;
      }

      // Step 2: Upload file directly to S3 (bypasses serverless function)
      const s3FormData = new FormData();
      for (const param of uploadData.parameters) {
        s3FormData.append(param.name, param.value);
      }
      s3FormData.append("file", file, file.name);
      
      const s3Response = await fetch(uploadData.uploadUrl, {
        method: "POST",
        body: s3FormData,
      });
      
      if (!s3Response.ok) {
        shopify.toast.show("S3 upload failed", { isError: true });
        return;
      }

      // Step 3: Create file in Shopify and attach to products
      const createResponse = await fetch("/app/direct-upload/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resourceUrl: uploadData.resourceUrl,
          filename: file.name,
          customIds: uploadData.customIds,
        }),
      });
      
      const result = await createResponse.json();
      
      if (result.success) {
        shopify.toast.show("Video uploaded successfully!");
        setFile(null);
        setCustomIds("");
      } else {
        shopify.toast.show(`Upload failed: ${result.error}`, { isError: true });
      }
    } catch (error) {
      shopify.toast.show(`Upload failed: ${error.message}`, { isError: true });
    }
  }, [file, customIds, isSubmitting, shopify]);

  const clearAll = useCallback(() => {
    setFile(null);
    setCustomIds("");
  }, []);

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show("Video uploaded successfully!");
    } else if (fetcher.data?.error) {
      shopify.toast.show(`Upload failed: ${fetcher.data.error}`, { isError: true });
    }
  }, [fetcher.data, shopify]);

  return (
    <Page>
      <TitleBar title="Direct Video Upload (Large Files)" />
      <Card>
        <BlockStack gap="400">
          <Text as="p" variant="bodyMd">
            Upload large video files directly to Shopify. This method bypasses serverless function limits.
          </Text>
          
          <DropZone accept="video/*" onDrop={onDrop}>
            <DropZone.FileUpload actionTitle="Select video file" actionHint="or drop to upload" />
          </DropZone>

          {file && (
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">Selected file</Text>
                <Text as="p" variant="bodyMd">
                  <strong>{file.name}</strong> ({(file.size / 1024 / 1024).toFixed(1)}MB)
                </Text>
                <Button onClick={() => setFile(null)} variant="tertiary">
                  Remove file
                </Button>
              </BlockStack>
            </Card>
          )}

          <TextField
            label="Product Custom IDs"
            value={customIds}
            onChange={setCustomIds}
            placeholder="54577;55242;54693"
            helpText="Enter custom IDs separated by semicolons"
            multiline={3}
          />

          <InlineStack gap="200">
            <Button 
              loading={isSubmitting} 
              disabled={!file || !customIds.trim()} 
              onClick={handleSubmit}
            >
              Upload Video
            </Button>
            <Button 
              disabled={!file && !customIds.trim() || isSubmitting} 
              onClick={clearAll} 
              variant="secondary"
            >
              Clear All
            </Button>
          </InlineStack>

          {fetcher.data?.results && (
            <BlockStack gap="200">
              <Banner 
                title={fetcher.data.success ? "Upload completed" : "Upload failed"} 
                tone={fetcher.data.success ? "success" : "critical"} 
              />
              <DataTable
                columnContentTypes={["text", "text"]}
                headings={["Custom ID", "Status"]}
                rows={fetcher.data.results.map((r) => [
                  r.customId,
                  r.status + (r.message ? `: ${r.message}` : ""),
                ])}
              />
            </BlockStack>
          )}
        </BlockStack>
      </Card>
    </Page>
  );
}
