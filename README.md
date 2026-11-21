# Papertrail - Public Document Q&A

Papertrail is a document assistant that answers questions about uploaded PDF and TXT files using retrieval-augmented generation.

The public demo has no login or sign-up. It uses Cloudflare Pages, Cloudflare Workers, KV rate limits, and Neon Postgres with pgvector. Demo uploads expire after 24 hours.

## Live deployment

- Portfolio: https://papertrail-e2c.pages.dev
- API: https://papertrail-api.tnsqqqbaliyan.workers.dev

## Run locally

Requirements: Node.js 18 or newer and npm.

```powershell
cd backend
npm install
npm run dev
```

In another terminal:

```powershell
cd frontend
npm install
npm run dev
```

Open http://localhost:3000.

Set `OPENAI_API_KEY` or `GEMINI_API_KEY` in `backend/.env` for model-generated answers. Without model keys, the app uses concise extractive answers. Scanned PDFs use local OCR; the cloud deployment accepts only PDFs with selectable text.

## Cloud deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for Cloudflare Pages, Workers, KV, Neon, and pgvector setup.

## Public protections

- PDF/TXT files only
- 5 MB maximum file size
- 3 uploads per IP per hour
- 30 queries per IP per hour
- Automatic deletion after 24 hours
- No login or account system

## API

- `GET /health`
- `GET /api/status`
- `GET /api/documents`
- `POST /api/documents/upload`
- `DELETE /api/documents/:id`
- `POST /api/query`

## Tests

```powershell
cd backend
npm test
```

```powershell
npm run build
```
