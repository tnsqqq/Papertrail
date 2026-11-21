import { neon } from '@neondatabase/serverless';

const JSON_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = (env.FRONTEND_ORIGIN || '').split(',').map((value) => value.trim()).filter(Boolean);
  const value = origin && (allowed.length === 0 || allowed.includes(origin)) ? origin : '*';
  return {
    'Access-Control-Allow-Origin': value,
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function sqlClient(env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not configured.');
  return neon(env.DATABASE_URL);
}

function publicIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 'anonymous';
}

async function enforceRateLimit(env, request, route, limit) {
  if (!env.PUBLIC_RATE_LIMIT || limit <= 0) return;
  const window = Math.floor(Date.now() / 3600000);
  const key = `papertrail:${route}:${publicIp(request)}:${window}`;
  const current = Number(await env.PUBLIC_RATE_LIMIT.get(key) || 0);
  if (current >= limit) {
    throw Object.assign(new Error('Rate limit reached. Please try again later.'), { status: 429 });
  }
  await env.PUBLIC_RATE_LIMIT.put(key, String(current + 1), { expirationTtl: 7200 });
}

function chunkText(text, maxChars = 2400, overlapChars = 480) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\t/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + maxChars, normalized.length);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf('\n\n', end);
      const candidate = boundary > start + maxChars * 0.5 ? boundary : normalized.lastIndexOf('. ', end);
      if (candidate > start) end = candidate + 1;
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }
  return chunks;
}

async function extractPdf(arrayBuffer) {
  const { extractText: extractPdfText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(arrayBuffer), {
    isEvalSupported: false,
    maxImageSize: 16777216,
  });
  const result = await extractPdfText(pdf, { mergePages: false });
  const pages = (Array.isArray(result.text) ? result.text : [result.text])
    .map((text, index) => ({ pageNumber: index + 1, text: String(text || '').replace(/\s+/g, ' ').trim() }))
    .filter((page) => page.text);
  return {
    text: pages.map((page) => page.text).join('\n\n'),
    numPages: result.totalPages,
    pages,
  };
}

async function extractText(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.txt')) {
    const text = (await file.text()).trim();
    if (!text) throw Object.assign(new Error('The TXT file is empty.'), { status: 400 });
    return { text, numPages: 1, pages: [{ pageNumber: 1, text }] };
  }
  const extracted = await extractPdf(await file.arrayBuffer());
  if (!extracted.text.trim()) {
    throw Object.assign(new Error('No selectable text was found in this PDF. Scanned PDFs are not supported in the public demo.'), { status: 400 });
  }
  return extracted;
}

async function openAiEmbeddings(env, inputs) {
  if (!env.OPENAI_API_KEY) return null;
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small', input: inputs }),
  });
  if (!response.ok) throw new Error(`Embedding API returned ${response.status}.`);
  const data = await response.json();
  return data.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
}

function hashEmbedding(text, dimensions = 1536) {
  const values = new Float64Array(dimensions);
  const terms = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const term of terms) {
    let hash = 2166136261;
    for (let index = 0; index < term.length; index += 1) {
      hash ^= term.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const slot = ((hash >>> 0) % dimensions);
    values[slot] += 1;
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!norm) return Array(dimensions).fill(0);
  return Array.from(values, (value) => value / norm);
}

async function embedTexts(env, texts) {
  const remote = await openAiEmbeddings(env, texts);
  return remote || texts.map((text) => hashEmbedding(text));
}

function pgVector(values) {
  return `[${values.join(',')}]`;
}

async function listDocuments(sql) {
  return sql`SELECT id::text, filename, mime_type, num_pages, total_chunks, uploaded_at, expires_at
             FROM documents
             WHERE expires_at > NOW()
             ORDER BY uploaded_at DESC`;
}

async function deleteDocument(sql, id) {
  const rows = await sql`SELECT id FROM documents WHERE id::text = ${id}`;
  if (rows.length === 0) return false;
  await sql`DELETE FROM documents WHERE id::text = ${id}`;
  return true;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function answerExtractively(query, chunks) {
  if (!chunks.length) return 'I could not find relevant content in the uploaded document.';
  const terms = query.toLowerCase().match(/[a-z0-9]+/g)?.filter((term) => term.length > 2) || [];
  const ranked = chunks.map((chunk) => {
    const lower = chunk.text.toLowerCase();
    return { ...chunk, score: terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0) };
  }).sort((a, b) => b.score - a.score);
  return ranked.slice(0, 5).map((chunk) => chunk.text).join('\n\n');
}

async function generateAnswer(env, query, chunks) {
  if (!env.GEMINI_API_KEY && !env.OPENAI_API_KEY) return answerExtractively(query, chunks);
  const context = chunks.map((chunk) => `[${chunk.filename}, page ${chunk.page_number}]\n${chunk.text}`).join('\n\n');

  if (env.GEMINI_API_KEY) {
    const model = env.GEMINI_CHAT_MODEL || 'gemini-2.0-flash';
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `Answer only from these excerpts:\n\n${context}\n\nQuestion: ${query}` }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 700 },
      }),
    });
    if (response.ok) {
      const data = await response.json();
      const answer = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (answer) return answer;
    }
  }

  if (env.OPENAI_API_KEY) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
        temperature: 0.1,
        max_tokens: 700,
        messages: [
          { role: 'system', content: 'Answer accurately using only the supplied document excerpts. If the excerpts do not contain the answer, say so.' },
          { role: 'user', content: `DOCUMENT EXCERPTS:\n${context}\n\nQUESTION: ${query}` },
        ],
      }),
    });
    if (response.ok) {
      const data = await response.json();
      const answer = data.choices?.[0]?.message?.content?.trim();
      if (answer) return answer;
    }
  }
  return answerExtractively(query, chunks);
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    const url = new URL(request.url);
    try {
      const sql = sqlClient(env);

      if (url.pathname === '/health') {
        return json({ status: 'healthy', timestamp: new Date().toISOString() }, 200, headers);
      }

      if (url.pathname === '/api/status' && request.method === 'GET') {
        return json({
          success: true,
          provider: 'cloudflare-neon-rag',
          vectorStore: { provider: 'neon_pgvector', isConnected: true },
          limits: { maxUploadBytes: Number(env.MAX_UPLOAD_BYTES || 5242880), retentionHours: Number(env.DOCUMENT_TTL_HOURS || 24) },
        }, 200, headers);
      }

      if (url.pathname === '/api/documents' && request.method === 'GET') {
        const documents = await listDocuments(sql);
        return json({ success: true, documents: documents.map((doc) => ({
          id: doc.id,
          filename: doc.filename,
          mimeType: doc.mime_type,
          numPages: doc.num_pages,
          totalChunks: doc.total_chunks,
          uploadedAt: doc.uploaded_at,
          expiresAt: doc.expires_at,
        })) }, 200, headers);
      }

      if (url.pathname === '/api/documents/upload' && request.method === 'POST') {
        await enforceRateLimit(env, request, 'upload', Number(env.PUBLIC_UPLOADS_PER_HOUR || 3));
        const form = await request.formData();
        const file = form.get('file');
        if (!(file instanceof File)) throw Object.assign(new Error('No file uploaded.'), { status: 400 });
        const name = file.name.toLowerCase();
        if (!name.endsWith('.pdf') && !name.endsWith('.txt')) throw Object.assign(new Error('Choose a PDF or TXT file.'), { status: 400 });
        const maxBytes = Number(env.MAX_UPLOAD_BYTES || 5242880);
        if (file.size > maxBytes) throw Object.assign(new Error('Files must be 5 MB or smaller.'), { status: 413 });

        const extracted = await extractText(file);
        const documentId = crypto.randomUUID();
        const ttlHours = Number(env.DOCUMENT_TTL_HOURS || 24);
        const fileBytes = new Uint8Array(await file.arrayBuffer());
        const fileBase64 = bytesToBase64(fileBytes);

        await sql`INSERT INTO documents (id, filename, mime_type, r2_key, file_base64, num_pages, total_chunks, expires_at)
                 VALUES (${documentId}, ${file.name}, ${file.type || 'application/octet-stream'}, ${`neon://${documentId}`}, ${fileBase64}, ${extracted.numPages}, 0, NOW() + (${ttlHours} * INTERVAL '1 hour'))`;

        const chunksByPage = [];
        for (const page of extracted.pages) {
          for (const chunk of chunkText(page.text)) {
            chunksByPage.push({ page: page.pageNumber, text: chunk });
          }
        }
        if (chunksByPage.length === 0) throw Object.assign(new Error('No searchable text could be extracted.'), { status: 400 });
        const embeddings = await embedTexts(env, chunksByPage.map((chunk) => chunk.text));

        for (let index = 0; index < chunksByPage.length; index += 1) {
          const chunkId = crypto.randomUUID();
          const chunk = chunksByPage[index];
          await sql`INSERT INTO document_chunks (id, document_id, filename, page_number, chunk_index, text, embedding)
                   VALUES (${chunkId}, ${documentId}, ${file.name}, ${chunk.page}, ${index}, ${chunk.text}, ${pgVector(embeddings[index])}::vector)`;
        }
        await sql`UPDATE documents SET total_chunks = ${chunksByPage.length} WHERE id = ${documentId}`;

        return json({
          success: true,
          document: {
            id: documentId,
            filename: file.name,
            numPages: extracted.numPages,
            totalChunks: chunksByPage.length,
            uploadedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + ttlHours * 3600000).toISOString(),
          },
        }, 201, headers);
      }

      const deleteMatch = url.pathname.match(/^\/api\/documents\/([^/]+)$/);
      if (deleteMatch && request.method === 'DELETE') {
        const deleted = await deleteDocument(sql, decodeURIComponent(deleteMatch[1]));
        if (!deleted) return json({ success: false, error: 'Document not found.' }, 404, headers);
        return json({ success: true, deleted: true }, 200, headers);
      }

      if (url.pathname === '/api/query' && request.method === 'POST') {
        await enforceRateLimit(env, request, 'query', Number(env.PUBLIC_QUERIES_PER_HOUR || 30));
        const body = await request.json();
        const query = typeof body.query === 'string' ? body.query.trim() : '';
        if (!query) return json({ success: false, error: 'Enter a question.' }, 400, headers);
        if (query.length > 2000) return json({ success: false, error: 'Questions must be 2000 characters or fewer.' }, 400, headers);
        const topK = Math.min(Math.max(Number(body.topK || 6), 1), 10);
        const [queryEmbedding] = await embedTexts(env, [query]);

        let chunks;
        if (body.documentId) {
          chunks = await sql`SELECT filename, page_number, text
                             FROM document_chunks
                             WHERE document_id = ${body.documentId}::uuid
                             ORDER BY embedding <=> ${pgVector(queryEmbedding)}::vector
                             LIMIT ${topK}`;
        } else {
          chunks = await sql`SELECT filename, page_number, text
                             FROM document_chunks
                             ORDER BY embedding <=> ${pgVector(queryEmbedding)}::vector
                             LIMIT ${topK}`;
        }

        const answer = await generateAnswer(env, query, chunks);
        return json({ success: true, answer, sources: chunks }, 200, headers);
      }

      return json({ success: false, error: 'API route not found.' }, 404, headers);
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(error);
      return json({ success: false, error: status >= 500 ? 'Internal server error.' : error.message }, status, headers);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      const sql = sqlClient(env);
      await sql`DELETE FROM documents WHERE expires_at <= NOW()`;
    })());
  },
};
