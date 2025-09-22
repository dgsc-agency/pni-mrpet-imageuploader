#!/usr/bin/env node
import { Command } from 'commander';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mime from 'mime-types';
import FormData from 'form-data';
import axios from 'axios';
import pLimit from 'p-limit';
import pRetry from 'p-retry';

dotenv.config();

const program = new Command();

program
  .option('--dir <dir>', 'Directory with images')
  .option('--mode <mode>', 'sku or custom-id or auto', 'sku')
  .option('--concurrency <n>', 'Parallel uploads', (v) => parseInt(v, 10), 3)
  .option('--limit <n>', 'Process up to N files', (v) => parseInt(v, 10), 0)
  .option('--start-from <filename>', 'Skip files until this basename is encountered')
  .option('--from-inclusive', 'Include the start-from file in processing', false)
  .option('--dry-run', 'Do not upload, only report matches', false)
  .parse(process.argv);

const opts = program.opts();

const SHOP = process.env.SHOP;
const TOKEN = process.env.ADMIN_ACCESS_TOKEN;
const API_VERSION = process.env.API_VERSION || '2025-01';

if (!SHOP || !TOKEN) {
  console.error('Missing SHOP or ADMIN_ACCESS_TOKEN in .env');
  process.exit(1);
}

const adminFetch = async (query, variables) => {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  return res;
};

function extractSkuAndIndexFromFilename(filename) {
  const base = path.basename(filename).split('?')[0];
  const nameOnly = base.includes('.') ? base.substring(0, base.lastIndexOf('.')) : base;
  const match = nameOnly.match(/^(.*?)(?:_(\d+))?$/);
  if (!match) return { sku: nameOnly.trim(), index: 0 };
  const sku = (match[1] || '').trim();
  const index = match[2] ? parseInt(match[2], 10) : 0;
  return { sku, index: Number.isFinite(index) ? index : 0 };
}

function extractCustomIdAndIndexFromFilename(filename) {
  const base = path.basename(filename).split('?')[0];
  const nameOnly = base.includes('.') ? base.substring(0, base.lastIndexOf('.')) : base;
  const match = nameOnly.match(/^(.*?)(?:_(\d+))?$/);
  if (!match) return { id: nameOnly.trim(), index: 0 };
  const id = (match[1] || '').trim();
  const index = match[2] ? parseInt(match[2], 10) : 0;
  return { id, index: Number.isFinite(index) ? index : 0 };
}

async function findProductByCustomId(customId) {
  const res = await adminFetch(
    `#graphql
      query FindProductByCustomId($identifier: ProductIdentifierInput!) {
        productByIdentifier(identifier: $identifier) { id title }
      }
    `,
    { identifier: { customId: { namespace: 'custom', key: 'id', value: customId } } },
  );
  const json = await res.json();
  const p = json?.data?.productByIdentifier;
  if (!p) return null;
  return { productId: p.id, productTitle: p.title };
}

async function findProductAndVariantBySku(sku) {
  const res = await adminFetch(
    `#graphql
      query VariantBySku($query: String!) {
        productVariants(first: 1, query: $query) {
          edges { node { id title product { id title } } }
        }
      }
    `,
    { query: `sku:${sku}` },
  );
  const json = await res.json();
  const edge = json?.data?.productVariants?.edges?.[0];
  if (!edge) return { productId: null, variantId: null, productTitle: null, variantTitle: null };
  return {
    productId: edge.node.product.id,
    variantId: edge.node.id,
    productTitle: edge.node.product.title,
    variantTitle: edge.node.title,
  };
}

async function createStagedUpload({ filename, mimeType, fileSize }) {
  const res = await adminFetch(
    `#graphql
      mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets { url resourceUrl parameters { name value } }
          userErrors { field message }
        }
      }
    `,
    { input: [{ resource: 'IMAGE', filename, mimeType: mimeType || 'image/jpeg', fileSize: String(fileSize ?? 0), httpMethod: 'POST' }] },
  );
  const json = await res.json();
  const target = json?.data?.stagedUploadsCreate?.stagedTargets?.[0];
  const errors = json?.data?.stagedUploadsCreate?.userErrors || [];
  return { target, errors };
}

async function uploadToS3Target(target, filePath, filename, mimeType) {
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  const stream = fs.createReadStream(filePath);
  form.append('file', stream, { filename, contentType: mimeType });
  try {
    const res = await axios.post(target.url, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120000,
      validateStatus: () => true,
    });
    return res.status >= 200 && res.status < 300;
  } catch (e) {
    return false;
  }
}

async function attachImageToProduct(productId, resourceUrl, altText) {
  const res = await adminFetch(
    `#graphql
      mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media { ... on MediaImage { id alt image { originalSrc } } }
          mediaUserErrors { field message }
        }
      }
    `,
    { productId, media: [{ alt: altText || null, originalSource: resourceUrl, mediaContentType: 'IMAGE' }] },
  );
  const json = await res.json();
  return { media: json?.data?.productCreateMedia?.media || [], errors: json?.data?.productCreateMedia?.mediaUserErrors || [] };
}

async function listProductImageMedia(productId) {
  const res = await adminFetch(
    `#graphql
      query ProductImageMedia($id: ID!) {
        product(id: $id) {
          media(first: 250) { nodes { id __typename ... on MediaImage { id alt image { originalSrc } } } }
        }
      }
    `,
    { id: productId },
  );
  const json = await res.json();
  const nodes = json?.data?.product?.media?.nodes || [];
  return nodes.filter((n) => n.__typename === 'MediaImage');
}

async function deleteProductMedia(productId, mediaIds) {
  if (!mediaIds.length) return { deleted: 0, errors: [] };
  const res = await adminFetch(
    `#graphql
      mutation ProductDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
        productDeleteMedia(productId: $productId, mediaIds: $mediaIds) { deletedMediaIds mediaUserErrors { field message } }
      }
    `,
    { productId, mediaIds },
  );
  const json = await res.json();
  const errors = json?.data?.productDeleteMedia?.mediaUserErrors || [];
  const deleted = json?.data?.productDeleteMedia?.deletedMediaIds?.length || 0;
  return { deleted, errors };
}

async function reorderProductMedia(productId, moves) {
  if (!moves?.length) return { success: true };
  const res = await adminFetch(
    `#graphql
      mutation ProductReorderMedia($id: ID!, $moves: [MoveInput!]!) {
        productReorderMedia(id: $id, moves: $moves) {
          userErrors { field message }
        }
      }
    `,
    { id: productId, moves },
  );
  const json = await res.json();
  const errors = json?.data?.productReorderMedia?.userErrors || [];
  return { success: !errors.length, errors };
}

async function waitForMediaReady(mediaId, { timeoutMs = 20000, intervalMs = 800 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await adminFetch(
      `#graphql
        query MediaStatus($id: ID!) { node(id: $id) { ... on Media { id status } } }
      `,
      { id: mediaId },
    );
    const json = await res.json();
    const status = json?.data?.node?.status;
    if (status === 'READY') return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function listVariantMedia(variantId) {
  const res = await adminFetch(
    `#graphql
      query VariantMedia($id: ID!) { productVariant(id: $id) { id media(first: 50) { nodes { id } } } }
    `,
    { id: variantId },
  );
  const json = await res.json();
  return json?.data?.productVariant?.media?.nodes?.map((n) => n.id) || [];
}

async function detachVariantMedia(variantId, mediaIds) {
  if (!mediaIds.length) return { removed: 0, errors: [] };
  const res = await adminFetch(
    `#graphql
      mutation ProductVariantDetachMedia($variantId: ID!, $mediaIds: [ID!]!) {
        productVariantDetachMedia(variantId: $variantId, mediaIds: $mediaIds) { detachedMediaIds userErrors { field message } }
      }
    `,
    { variantId, mediaIds },
  );
  const json = await res.json();
  const errors = json?.data?.productVariantDetachMedia?.userErrors || [];
  const removed = json?.data?.productVariantDetachMedia?.detachedMediaIds?.length || 0;
  return { removed, errors };
}

async function appendVariantMedia(variantId, mediaId) {
  const res = await adminFetch(
    `#graphql
      mutation ProductVariantAppendMedia($variantId: ID!, $mediaIds: [ID!]!) {
        productVariantAppendMedia(variantId: $variantId, mediaIds: $mediaIds) { attachedToVariantIds userErrors { field message } }
      }
    `,
    { variantId, mediaIds: [mediaId] },
  );
  const json = await res.json();
  const errors = json?.data?.productVariantAppendMedia?.userErrors || [];
  return { errors };
}

async function bulkSetVariantMedia(productId, variantId, mediaId) {
  const res = await adminFetch(
    `#graphql
      mutation VariantSetMedia($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id } userErrors { field message } }
      }
    `,
    { productId, variants: [{ id: variantId, mediaId }] },
  );
  const json = await res.json();
  const errors = json?.data?.productVariantsBulkUpdate?.userErrors || [];
  return { errors };
}

async function processFile(filePath) {
  const filename = path.basename(filePath);
  const mimeType = mime.lookup(filename) || 'image/jpeg';
  const stats = fs.statSync(filePath);

  let productId = null;
  let productTitle = null;
  let variantId = null;
  let variantTitle = null;
  let isProductLevel = false;
  let uploadIndex = 0;

  // Resolve mapping depending on mode
  if (opts.mode === 'custom-id') {
    const { id: customId, index } = extractCustomIdAndIndexFromFilename(filename);
    uploadIndex = index;
    const p = await findProductByCustomId(customId);
    if (!p) return { filename, status: 'no_product_for_custom_id' };
    productId = p.productId; productTitle = p.productTitle; isProductLevel = true;
  } else if (opts.mode === 'sku') {
    const { sku, index } = extractSkuAndIndexFromFilename(filename);
    uploadIndex = index;
    const v = await findProductAndVariantBySku(sku);
    if (!v.productId) return { filename, status: 'no_product_for_sku' };
    productId = v.productId; variantId = v.variantId; productTitle = v.productTitle; variantTitle = v.variantTitle; isProductLevel = false;
  } else {
    // auto: try custom-id first
    const { id: customId, index } = extractCustomIdAndIndexFromFilename(filename);
    uploadIndex = index;
    const p = await findProductByCustomId(customId);
    if (p && p.productId) {
      productId = p.productId; productTitle = p.productTitle; isProductLevel = true;
    } else {
      const { sku } = extractSkuAndIndexFromFilename(filename);
      const v = await findProductAndVariantBySku(sku);
      if (!v.productId) return { filename, status: 'no_product_for_id_or_sku' };
      productId = v.productId; variantId = v.variantId; productTitle = v.productTitle; variantTitle = v.variantTitle; isProductLevel = false;
    }
  }

  if (opts.dry_run) return { filename, productId, status: 'matched' };

  // Duplicate detection aligned with app logic
  const uploadedBaseName = (filename.split('/').pop() || filename).split('?')[0].toLowerCase();
  const existingImages = await listProductImageMedia(productId);
  let altLabel = null;
  if (!isProductLevel) {
    // SKU mode: expected alt label equals product/variant title pattern; we can't reconstruct titles here reliably
    // but we can use filename-based label for legacy created alts
    const { sku } = extractSkuAndIndexFromFilename(filename);
    altLabel = uploadIndex === 0 ? sku : `${sku}_${uploadIndex}`;
  } else {
    // Custom-id mode: expected alt equals productTitle (+ (n+1) if not base)
    altLabel = productTitle || null;
    if (altLabel && uploadIndex > 0) altLabel = `${altLabel} (${uploadIndex + 1})`;
  }
  const toReplace = existingImages.filter((img) => {
    const alt = (img.alt || '').trim();
    const src = img?.image?.originalSrc || '';
    const existingBaseName = (src.split('/').pop() || '').split('?')[0].toLowerCase();
    const altMatches = altLabel ? alt.toLowerCase() === altLabel.toLowerCase() : false;
    const fileMatches = !!existingBaseName && existingBaseName === uploadedBaseName;
    return altMatches || fileMatches;
  });
  if (toReplace.length) {
    await deleteProductMedia(productId, toReplace.map((i) => i.id));
  }

  const { target, errors: stagedErrors } = await createStagedUpload({ filename, mimeType, fileSize: stats.size });
  if (!target) return { filename, productId, status: 'staged_upload_error', errors: stagedErrors };

  const uploaded = await uploadToS3Target(target, filePath, filename, mimeType);
  if (!uploaded) return { filename, productId, status: 's3_upload_failed' };

  // Alt text: mirror app logic
  let altText = productTitle || filename;
  if (!isProductLevel && productTitle && variantTitle) {
    altText = `${productTitle} - ${variantTitle}`;
    if (uploadIndex > 0) altText += ` (${uploadIndex + 1})`;
  } else if (productTitle) {
    if (uploadIndex > 0) altText = `${productTitle} (${uploadIndex + 1})`;
  }
  const { media, errors: attachErrors } = await attachImageToProduct(productId, target.resourceUrl, altText);
  if (attachErrors?.length) return { filename, productId, status: 'attach_failed', errors: attachErrors };

  const createdId = media?.[0]?.id;
  if (!createdId) return { filename, productId, status: 'no_media_id' };

  // Optional: map to variant when in SKU mode
  if (!isProductLevel && uploadIndex === 0 && variantId && createdId) {
    const ready = await waitForMediaReady(createdId);
    if (ready) {
      const { errors: bulkErrors } = await bulkSetVariantMedia(productId, variantId, createdId);
      if (bulkErrors?.length) {
        // Fallback detach/append
        const currentVariantMedia = await listVariantMedia(variantId);
        if (currentVariantMedia.length) await detachVariantMedia(variantId, currentVariantMedia);
        await appendVariantMedia(variantId, createdId);
      }
    }
  }

  // Reorder: product-level (custom.id) first sorted by suffix (none, (2), (3)...), then variant-level
  const existing = await listProductImageMedia(productId);
  const productLevel = [];
  const variantLevelGroup = [];
  const others = [];
  for (const n of existing) {
    const alt = (n.alt || '').trim();
    if (productTitle && alt === productTitle) {
      productLevel.push({ id: n.id, idx: 0 });
    } else {
      const m = alt.match(/^(.+?) \((\d+)\)$/);
      if (m && m[1] === productTitle) {
        const idx = parseInt(m[2], 10);
        productLevel.push({ id: n.id, idx: Number.isFinite(idx) ? idx - 1 : 0 });
      } else if (productTitle && alt.startsWith(`${productTitle} - `)) {
        variantLevelGroup.push(n.id);
      } else {
        others.push(n.id);
      }
    }
  }
  productLevel.sort((a, b) => a.idx - b.idx);
  let finalOrder;
  if (productLevel.length === 0 && variantLevelGroup.length > 0) {
    // No product-level images exist: promote variant-level to the front
    finalOrder = [
      ...variantLevelGroup,
      ...others.filter((id) => !variantLevelGroup.includes(id)),
    ];
  } else {
    finalOrder = [
      ...productLevel.map((x) => x.id),
      ...others.filter((id) => !variantLevelGroup.includes(id)),
      ...variantLevelGroup,
    ];
  }
  const moves = finalOrder.map((id, i) => ({ id, newPosition: String(i + 1) }));
  await reorderProductMedia(productId, moves);

  return { filename, productId, status: 'ok', mediaId: createdId };
}

async function main() {
  const dir = opts.dir;
  if (!dir || !fs.existsSync(dir)) {
    console.error('--dir is required and must exist');
    process.exit(1);
  }
  const allFiles = fs.readdirSync(dir)
    .filter((f) => !f.startsWith('.'))
    .sort((a, b) => a.localeCompare(b))
    .map((f) => path.join(dir, f));

  let startIdx = 0;
  if (opts.startFrom) {
    const target = opts.startFrom;
    const idx = allFiles.findIndex((fp) => path.basename(fp) === target);
    if (idx >= 0) startIdx = opts.fromInclusive ? idx : idx + 1;
  }
  const pending = allFiles.slice(startIdx);
  const files = opts.limit > 0 ? pending.slice(0, opts.limit) : pending;

  console.log(`Processing ${files.length} files (mode=${opts.mode}, concurrency=${opts.concurrency})`);

  const limit = pLimit(opts.concurrency);
  let ok = 0, fail = 0;
  const results = await Promise.all(files.map((fp) => limit(() => pRetry(() => processFile(fp), { retries: 2 }))
    .then((r) => { if (r.status === 'ok') ok++; else fail++; console.log(`${r.status}: ${r.filename}${r.productId ? ' -> ' + r.productId : ''}`); return r; })
    .catch((e) => { fail++; console.log(`error: ${path.basename(fp)}: ${e.message}`); return { filename: path.basename(fp), status: 'error', message: e.message }; })));

  console.log(`Done. ok=${ok}, failed=${fail}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

