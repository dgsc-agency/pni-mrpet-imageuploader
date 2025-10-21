import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// Helper functions
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

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  
  try {
    const { resourceUrl, filename, customIds } = await request.json();

    if (!resourceUrl || !filename || !customIds?.length) {
      return json({ success: false, error: "Missing required data" });
    }

    // Step 1: Create file in Shopify
    const { files, errors: fileErrors } = await createFileInShopify(admin, resourceUrl, filename);
    if (fileErrors?.length) {
      return json({ success: false, error: "File creation failed", errors: fileErrors });
    }

    const fileId = files?.[0]?.id;
    if (!fileId) {
      return json({ success: false, error: "No file ID returned" });
    }

    // Step 2: Attach to all products
    const results = [];
    for (const customId of customIds) {
      try {
        const productMatch = await findProductByCustomId(admin, customId);
        if (!productMatch?.productId) {
          results.push({ customId, status: "no_product_found" });
          continue;
        }

        const { media, errors: attachErrors } = await attachVideoToProduct(
          admin,
          productMatch.productId,
          fileId,
          productMatch.productTitle || customId,
        );

        if (attachErrors?.length) {
          results.push({ customId, status: "attach_failed", errors: attachErrors });
        } else {
          results.push({ customId, status: "success", productId: productMatch.productId });
        }
      } catch (error) {
        results.push({ customId, status: "error", message: error.message });
      }
    }

    return json({ success: true, results, fileId });
  } catch (error) {
    return json({ success: false, error: error.message });
  }
};
