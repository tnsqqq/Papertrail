# Papertrail Cloud Deployment

Papertrail has no login or sign-up. Documents are public demo data and expire automatically.

## Services

- Cloudflare Pages: Vite frontend
- Cloudflare Workers: API and public protections
- Neon: Postgres database
- pgvector: semantic document search

## 1. Create the Cloudflare resources

Create a KV namespace, then update `wrangler.toml`:

```powershell
npx wrangler kv namespace create PUBLIC_RATE_LIMIT
```

Put the returned KV namespace ID into the `kv_namespaces.id` setting in `wrangler.toml`. Uploaded file bytes are stored temporarily in Neon, so no paid object-storage service is required.

## 2. Create the Neon database

Create a Neon project and database. Add the pooled connection string as a Worker secret:

```powershell
npx wrangler secret put DATABASE_URL
```

Run the migration through Neon SQL Editor or the Neon CLI:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Then execute `migrations/0001_init.sql`.

Use a pooled connection string for `DATABASE_URL`. Use a direct Neon connection string only for migrations.

## 3. Configure optional AI providers

Without model keys, the app uses a local extractive fallback.

```powershell
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GEMINI_API_KEY
```

Set `FRONTEND_ORIGIN` to the Pages origin and custom domain in `wrangler.toml`:

```toml
[vars]
FRONTEND_ORIGIN = "https://papertrail.pages.dev"
```

## 4. Deploy

```powershell
npm install
npx wrangler login
npm run deploy
```

## Public protections

The Worker enforces:

- PDF/TXT files only
- 5 MB maximum
- 3 uploads per IP per hour
- 30 queries per IP per hour
- Automatic deletion after 24 hours
- No login or account data

Scanned PDFs without selectable text are rejected rather than running OCR. This is deliberate: the browser, Worker, and Neon architecture is serverless and does not support the native OCR stack used by the local desktop version.
