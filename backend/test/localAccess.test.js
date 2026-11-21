import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const storageDir = await mkdtemp(path.join(os.tmpdir(), 'papertrail-local-access-test-'));
const previousEnvironment = {
  RAG_STORAGE_DIR: process.env.RAG_STORAGE_DIR,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
};
process.env.RAG_STORAGE_DIR = storageDir;
process.env.OPENAI_API_KEY = '';
process.env.GEMINI_API_KEY = '';

const documentId = 'local-library-document';
await writeFile(path.join(storageDir, 'documents_meta.json'), JSON.stringify({
  [documentId]: {
    id: documentId,
    ownerId: 'legacy-owner',
    filename: 'local.txt',
    storedFilename: 'private-storage-name.txt',
    uploadedAt: new Date().toISOString(),
    numPages: 1,
    totalChunks: 1,
  },
}));
await writeFile(path.join(storageDir, 'vector_store.json'), JSON.stringify({
  chunks: [{
    chunkId: 'local-library-chunk',
    documentId,
    ownerId: 'legacy-owner',
    filename: 'local.txt',
    page: 1,
    chunkIndex: 0,
    text: 'This document is part of the local library on this computer.',
    tokenCount: 14,
    embedding: [1, 0],
  }],
}));

const express = (await import('express')).default;
const documentRoutes = (await import('../routes/documentRoutes.js')).default;
const queryRoutes = (await import('../routes/queryRoutes.js')).default;
const app = express();
app.use(express.json());
app.use('/api/documents', documentRoutes);
app.use('/api/query', queryRoutes);

const server = await new Promise((resolve) => {
  const instance = app.listen(0, () => resolve(instance));
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await rm(storageDir, { recursive: true, force: true });
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test('the local app opens and supports document listing, querying, upload, and deletion without accounts', async () => {
  const listResponse = await fetch(`${baseUrl}/api/documents`);
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.deepEqual(list.documents.map((document) => document.id), [documentId]);

  const detailsResponse = await fetch(`${baseUrl}/api/documents/${documentId}`);
  assert.equal(detailsResponse.status, 200);
  const details = await detailsResponse.json();
  assert.equal(details.chunks[0].text.includes('local library'), true);

  const queryResponse = await fetch(`${baseUrl}/api/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: 'What is in this local library?' }),
  });
  assert.equal(queryResponse.status, 200);
  assert.equal((await queryResponse.json()).success, true);

  const form = new FormData();
  form.append('file', new Blob(['This is a newly uploaded local document with useful test content.'], {
    type: 'text/plain',
  }), 'new-local-document.txt');
  const uploadResponse = await fetch(`${baseUrl}/api/documents/upload`, { method: 'POST', body: form });
  assert.equal(uploadResponse.status, 201);
  const upload = await uploadResponse.json();

  const deleteResponse = await fetch(`${baseUrl}/api/documents/${upload.document.id}`, { method: 'DELETE' });
  assert.equal(deleteResponse.status, 200);
  assert.equal((await deleteResponse.json()).success, true);
});
