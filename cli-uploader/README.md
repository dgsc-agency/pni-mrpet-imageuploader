# CLI Uploader

Standalone Node.js CLI to bulk upload images to Shopify and assign to products.

Features:
- SKU and custom.id mapping (same as app).
- Variant mapping and product-level uploads.
- Reorder so product-level comes first.
- Concurrency, retries, dry-run, and test limits.

## Setup

1) Create `.env` in this folder with:

```
SHOP=your-shop.myshopify.com
ADMIN_ACCESS_TOKEN=shpat_xxx
API_VERSION=2025-01
```

Scopes required: `read_products,write_products,write_files`.

2) Install deps:

```
npm install
```

## Usage

```
node src/index.js --dir /path/to/images --mode sku --concurrency 4 --limit 100
node src/index.js --dir /path/to/images --mode custom-id --concurrency 4
```

Flags:
- `--dir` Folder containing images
- `--mode` `sku` or `custom-id`
- `--concurrency` Number of parallel uploads (default 3)
- `--limit` Process up to N files for testing
- `--dry-run` Only report matches, don’t upload

Output: console logs with per-file status; a summary at the end.

