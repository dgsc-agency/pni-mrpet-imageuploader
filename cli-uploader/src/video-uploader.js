#!/usr/bin/env node
import { Command } from 'commander';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import axios from 'axios';
import pLimit from 'p-limit';
import mime from 'mime-types';

dotenv.config();

const program = new Command();
program
  .option('--dir <dir>', 'Directory with videos')
  .option('--concurrency <n>', 'Parallel uploads', (v) => parseInt(v, 10), 3)
  .option('--limit <n>', 'Process up to N files', (v) => parseInt(v, 10), 0)
  .option('--dry-run', 'Do not upload, only report matches', false)
  .option('--poll-ms <n>', 'Polling interval ms for READY', (v) => parseInt(v, 10), 2500)
  .option('--poll-timeout-ms <n>', 'Max poll time ms', (v) => parseInt(v, 10), 180000)
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

function extractCustomIdFromFilename(filename) {
  const base = path.basename(filename).split('?')[0];
  const nameOnly = base.includes('.') ? base.substring(0, base.lastIndexOf('.')) : base;
  return nameOnly.trim();
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
    { input: [{ resource: 'VIDEO', filename, mimeType: mimeType || 'video/mp4', fileSize: String(fileSize ?? 0), httpMethod: 'POST' }] },
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
  const res = await axios.post(target.url, form, { headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 300000, validateStatus: () => true });
  return res.status >= 200 && res.status < 300;
}

async function attachVideoToProductBySource(productId, resourceUrl, altText) {
  const res = await adminFetch(
    `#graphql
      mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media { ... on Media { id alt } }
          mediaUserErrors { field message }
        }
      }
    `,
    { productId, media: [{ originalSource: resourceUrl, mediaContentType: 'VIDEO', alt: altText || null }] },
  );
  const json = await res.json();
  return { media: json?.data?.productCreateMedia?.media || [], errors: json?.data?.productCreateMedia?.mediaUserErrors || [] };
}

async function createVideoFileFromStaged(resourceUrl, altText) {
  const res = await adminFetch(
    `#graphql
      mutation FileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files { __typename ... on Video { id fileStatus url } }
          userErrors { field message }
        }
      }
    `,
    { files: [{ contentType: 'VIDEO', originalSource: resourceUrl, alt: altText || null }] },
  );
  const json = await res.json();
  const file = json?.data?.fileCreate?.files?.[0] || null;
  const errors = json?.data?.fileCreate?.userErrors || [];
  return { file, errors, raw: json };
}

async function pollVideoReady(videoId, intervalMs, timeoutMs) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const res = await adminFetch(
      `#graphql
        query MediaStatus($id: ID!) {
          node(id: $id) { id ... on Media { status } ... on Video { fileStatus } }
        }
      `,
      { id: videoId },
    );
    const json = await res.json();
    last = json?.data?.node;
    const status = last?.status || last?.fileStatus;
    if (status === 'READY') return { ready: true };
    if (status === 'FAILED') return { ready: false, last };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ready: false, last, timeout: true };
}

async function processVideo(filePath) {
  const filename = path.basename(filePath);
  const mimeType = mime.lookup(filename) || 'video/mp4';
  const stats = fs.statSync(filePath);

  const customId = extractCustomIdFromFilename(filename);
  const p = await findProductByCustomId(customId);
  if (!p) return { filename, status: 'no_product_for_custom_id' };
  const { productId, productTitle } = p;

  if (opts.dryRun) return { filename, productId, status: 'matched' };

  const { target, errors: stagedErrors } = await createStagedUpload({ filename, mimeType, fileSize: stats.size });
  if (!target) {
    console.log('staged_upload_error:', { filename, errors: stagedErrors });
    return { filename, productId, status: 'staged_upload_error', errors: stagedErrors };
  }
  console.log('staged_upload_target:', { filename, resourceUrl: target.resourceUrl, postUrl: target.url });

  const uploaded = await uploadToS3Target(target, filePath, filename, mimeType);
  if (!uploaded) {
    console.log('s3_upload_failed:', { filename });
    return { filename, productId, status: 's3_upload_failed' };
  }

  const altText = productTitle || customId;
  // Create File (VIDEO) from staged URL, poll READY, then attach by mediaId
  const { file, errors: fileErr, raw } = await createVideoFileFromStaged(target.resourceUrl, altText);
  if (fileErr?.length || !file?.id) {
    console.log('file_create_failed:', { filename, errors: fileErr, raw });
    // fallback: try direct attach by originalSource
    const { media, errors: attachErrors } = await attachVideoToProductBySource(productId, target.resourceUrl, altText);
    if (attachErrors?.length) {
      console.log('attach_failed:', { filename, errors: attachErrors });
      return { filename, productId, status: 'attach_failed', errors: attachErrors };
    }
    return { filename, productId, status: 'ok', media };
  }

  const poll = await pollVideoReady(file.id, opts.pollMs, opts.pollTimeoutMs);
  if (!poll.ready) {
    console.log('video_not_ready', { filename, videoId: file.id, last: poll.last, timeout: !!poll.timeout });
    // still try to attach; Shopify may finish processing later
  }

  // Attach using mediaId
  const resAttach = await adminFetch(
    `#graphql
      mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media { ... on Media { id alt } }
          mediaUserErrors { field message }
        }
      }
    `,
    { productId, media: [{ mediaId: file.id, alt: altText || null }] },
  );
  const jsonAttach = await resAttach.json();
  const attachErrors = jsonAttach?.data?.productCreateMedia?.mediaUserErrors || [];
  if (attachErrors?.length) {
    console.log('attach_failed_mediaId:', { filename, errors: attachErrors });
    return { filename, productId, status: 'attach_failed', errors: attachErrors };
  }
  const media = jsonAttach?.data?.productCreateMedia?.media || [];
  return { filename, productId, status: 'ok', media };
}

async function main() {
  const dir = opts.dir;
  if (!dir || !fs.existsSync(dir)) {
    console.error('--dir is required and must exist');
    process.exit(1);
  }
  const allFiles = fs.readdirSync(dir)
    .filter((f) => !f.startsWith('.'))
    .map((f) => path.join(dir, f));
  const files = opts.limit > 0 ? allFiles.slice(0, opts.limit) : allFiles;

  console.log(`Processing ${files.length} videos (concurrency=${opts.concurrency})`);
  const limit = pLimit(opts.concurrency);
  let ok = 0, fail = 0;
  await Promise.all(files.map((fp) => limit(async () => {
    try {
      const r = await processVideo(fp);
      if (r.status === 'ok') ok++; else fail++;
      console.log(`${r.status}: ${r.filename}${r.productId ? ' -> ' + r.productId : ''}`);
    } catch (e) {
      fail++;
      console.log(`error: ${path.basename(fp)}: ${e.message}`);
    }
  })));
  console.log(`Done. ok=${ok}, failed=${fail}`);
}

main().catch((e) => { console.error(e); process.exit(1); });


