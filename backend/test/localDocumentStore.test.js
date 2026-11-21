import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const storageDir = await mkdtemp(path.join(os.tmpdir(), 'papertrail-local-documents-test-'));
const previousStorageDir = process.env.RAG_STORAGE_DIR;
process.env.RAG_STORAGE_DIR = storageDir;

await writeFile(path.join(storageDir, 'documents_meta.json'), JSON.stringify({
  'legacy-document': {
    id: 'legacy-document',
    ownerId: 'obsolete-account-id',
    filename: 'legacy.txt',
    storedFilename: 'legacy.txt',
    uploadedAt: new Date().toISOString(),
  },
}));
await writeFile(path.join(storageDir, 'vector_store.json'), JSON.stringify({
  chunks: [{
    chunkId: 'legacy-chunk',
    documentId: 'legacy-document',
    ownerId: 'obsolete-account-id',
    filename: 'legacy.txt',
    page: 1,
    chunkIndex: 0,
    text: 'Old local content remains available.',
    tokenCount: 6,
    embedding: [1, 0],
  }],
}));

const {
  addDocumentChunks,
  deleteDocument,
  getAllDocuments,
  getDocumentById,
  getDocumentChunks,
  getVectorStoreStats,
  querySimilarChunks,
} = await import('../services/chromaService.js?local-documents-test');

after(async () => {
  await rm(storageDir, { recursive: true, force: true });
  if (previousStorageDir === undefined) delete process.env.RAG_STORAGE_DIR;
  else process.env.RAG_STORAGE_DIR = previousStorageDir;
});

test('local document operations list, search, and delete indexed documents', async () => {
  const chunk = {
    chunkId: 'new-document-chunk',
    documentId: 'new-document',
    filename: 'new.txt',
    page: 1,
    chunkIndex: 0,
    text: 'New local content is indexed without an account.',
    tokenCount: 8,
  };
  await addDocumentChunks([chunk], [[0.8, 0.2]], {
    documentId: 'new-document',
    filename: 'new.txt',
    storedFilename: 'new.txt',
  });

  assert.deepEqual(getAllDocuments().map((document) => document.id).sort(), [
    'legacy-document',
    'new-document',
  ]);
  assert.equal(getDocumentById('new-document').filename, 'new.txt');
  assert.deepEqual(getDocumentChunks('legacy-document').map((item) => item.text), [
    'Old local content remains available.',
  ]);
  assert.equal(getVectorStoreStats().totalDocuments, 2);

  const hits = await querySimilarChunks([1, 0], 10);
  assert.equal(hits.some((item) => item.documentId === 'legacy-document'), true);
  assert.equal(hits.some((item) => item.documentId === 'new-document'), true);

  assert.deepEqual(await deleteDocument('legacy-document'), { success: true, deleted: true });
  assert.equal(getDocumentById('legacy-document'), null);
});
