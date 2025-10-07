#!/usr/bin/env node
import { Command } from 'commander';
import dotenv from 'dotenv';
import pLimit from 'p-limit';

dotenv.config();

const program = new Command();
program
  .option('--concurrency <n>', 'Parallel deletions', (v) => parseInt(v, 10), 5)
  .option('--dry-run', 'List product IDs but do not delete', false)
  .option('--yes', 'Confirm deletion without prompt', false)
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
  return res.json();
};

async function listProductIds(cursor = null) {
  const data = await adminFetch(
    `#graphql
      query ListProducts($cursor: String) {
        products(first: 250, after: $cursor) { edges { cursor node { id title } } pageInfo { hasNextPage endCursor } }
      }
    `,
    { cursor }
  );
  const edges = data?.data?.products?.edges || [];
  const ids = edges.map((e) => e.node.id);
  const pageInfo = data?.data?.products?.pageInfo || { hasNextPage: false, endCursor: null };
  return { ids, pageInfo };
}

async function deleteProducts(ids) {
  const results = [];
  const limit = pLimit(opts.concurrency);
  await Promise.all(ids.map((id) => limit(async () => {
    const resp = await adminFetch(
      `#graphql
        mutation DeleteProduct($id: ID!) {
          productDelete(input: { id: $id }) { deletedProductId userErrors { field message } }
        }
      `,
      { id }
    );
    const deleted = resp?.data?.productDelete?.deletedProductId;
    const errs = resp?.data?.productDelete?.userErrors || [];
    if (deleted) {
      console.log(`deleted: ${deleted}`);
      results.push({ id: deleted, status: 'deleted' });
    } else if (errs.length) {
      console.log(`error: ${id}: ${errs.map(e => e.message).join(', ')}`);
      results.push({ id, status: 'error', errors: errs });
    } else {
      console.log(`unknown: ${id}`);
      results.push({ id, status: 'unknown' });
    }
  })));
  return results;
}

async function main() {
  if (!opts.yes && !opts.dryRun) {
    console.log('Refusing to delete without --yes. Use --dry-run to preview.');
    process.exit(1);
  }

  let cursor = null;
  let total = 0;
  while (true) {
    const { ids, pageInfo } = await listProductIds(cursor);
    if (!ids.length) break;
    if (opts.dryRun) {
      ids.forEach((id) => console.log(`would delete: ${id}`));
      total += ids.length;
    } else {
      const res = await deleteProducts(ids);
      total += res.length;
    }
    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }
  console.log(`Done. processed=${total}`);
}

main().catch((e) => { console.error(e); process.exit(1); });


