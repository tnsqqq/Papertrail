import { ChromaClient } from 'chromadb';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { rankRetrievedChunks } from './retrievalService.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const storageDir = path.resolve(
  process.env.RAG_STORAGE_DIR?.trim() || path.join(__dirname, '..', 'uploads')
);
const localStorePath = path.join(storageDir, 'vector_store.json');
const docsMetaPath = path.join(storageDir, 'documents_meta.json');

// Ensure storage directory exists
if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir, { recursive: true });
}

let chromaClient = null;
let chromaCollection = null;
let isChromaConnected = false;

// In-memory cache of chunks for fast retrieval and local fallback
let localStore = {
  chunks: [], // Array of { id, documentId, filename, page, chunkIndex, text, tokenCount, embedding }
};

let documentsMeta = {}; // documentId -> { id, filename, originalName, numPages, totalChunks, totalTokens, uploadedAt }

// Load persisted local stores if they exist
try {
  if (fs.existsSync(localStorePath)) {
    const raw = fs.readFileSync(localStorePath, 'utf-8');
    const storedData = JSON.parse(raw);
    if (!storedData || !Array.isArray(storedData.chunks)) {
      throw new Error('Local vector store must contain a chunks array.');
    }
    localStore = storedData;
    console.log(`[VectorStore] Loaded ${localStore.chunks.length} cached chunks from disk.`);
  }
} catch (e) {
  console.warn('[VectorStore] Warning reading local vector store:', e.message);
}

try {
  if (fs.existsSync(docsMetaPath)) {
    const raw = fs.readFileSync(docsMetaPath, 'utf-8');
    const storedData = JSON.parse(raw);
    if (!storedData || Array.isArray(storedData) || typeof storedData !== 'object') {
      throw new Error('Document metadata must be an object.');
    }
    documentsMeta = storedData;
    console.log(`[VectorStore] Loaded metadata for ${Object.keys(documentsMeta).length} documents.`);
  }
} catch (e) {
  console.warn('[VectorStore] Warning reading documents metadata:', e.message);
}

function persistLocalStore() {
  try {
    fs.writeFileSync(localStorePath, JSON.stringify(localStore, null, 2), 'utf-8');
  } catch (err) {
    console.error('[VectorStore] Failed to persist local vector store:', err.message);
    throw err;
  }
}

function persistDocumentsMeta() {
  try {
    fs.writeFileSync(docsMetaPath, JSON.stringify(documentsMeta, null, 2), 'utf-8');
  } catch (err) {
    console.error('[VectorStore] Failed to persist documents metadata:', err.message);
    throw err;
  }
}

/**
 * Calculates cosine similarity between two unit-normalized vectors.
 */
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

/**
 * Initializes the vector store.
 * Tries ChromaDB; if unreachable, gracefully continues with local fallback.
 */
export async function initVectorStore() {
  const collectionName = process.env.CHROMA_COLLECTION_NAME || 'document_rag_collection';
  if (process.env.RAG_DISABLE_CHROMA === 'true') {
    isChromaConnected = false;
    chromaClient = null;
    chromaCollection = null;
    return { connected: false, provider: 'local_resilient_store', collection: collectionName };
  }

  const chromaUrl = process.env.CHROMA_URL || 'http://localhost:8000';

  try {
    const parsedUrl = new URL(chromaUrl);
    chromaClient = new ChromaClient({
      ssl: parsedUrl.protocol === 'https:',
      host: parsedUrl.hostname,
      port: parsedUrl.port ? parseInt(parsedUrl.port, 10) : (parsedUrl.protocol === 'https:' ? 443 : 8000),
    });
    const heartbeat = await Promise.race([
      chromaClient.heartbeat(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2500)),
    ]);

    if (heartbeat) {
      chromaCollection = await chromaClient.getOrCreateCollection({
        name: collectionName,
        metadata: { 'hnsw:space': 'cosine' },
      });
      isChromaConnected = true;
      console.log(`[ChromaDB] Successfully connected to ChromaDB at ${chromaUrl} (collection: "${collectionName}")`);
      return { connected: true, provider: 'chromadb', collection: collectionName };
    }
  } catch (err) {
    isChromaConnected = false;
    chromaCollection = null;
    console.warn(`[ChromaDB] ChromaDB server not reachable at ${chromaUrl} (${err.message}). Using resilient local vector store.`);
  }

  return { connected: false, provider: 'local_resilient_store', collection: collectionName };
}

/**
 * Adds document chunks with their embeddings to vector store.
 *
 * @param {Array<Object>} chunks Array of chunk objects from chunkingService
 * @param {Array<number[]>} embeddings Array of vectors from embeddingService
 * @param {Object} documentInfo Document high-level metadata
 */
export async function addDocumentChunks(chunks, embeddings, documentInfo) {
  if (!chunks || chunks.length === 0) return { insertedCount: 0 };
  if (!Array.isArray(embeddings) || embeddings.length !== chunks.length || embeddings.some((vector) => !Array.isArray(vector) || vector.length === 0)) {
    throw new Error('Each document chunk must have a matching non-empty embedding.');
  }

  // Save document metadata
  if (documentInfo && documentInfo.documentId) {
    documentsMeta[documentInfo.documentId] = {
      id: documentInfo.documentId,
      filename: documentInfo.filename,
      originalName: documentInfo.originalName || documentInfo.filename,
      storedFilename: documentInfo.storedFilename,
      numPages: documentInfo.numPages || 1,
      totalChunks: chunks.length,
      totalTokens: chunks.reduce((acc, c) => acc + (c.tokenCount || 0), 0),
      uploadedAt: documentInfo.uploadedAt || new Date().toISOString(),
      fileSize: documentInfo.fileSize || 0,
      mimeType: documentInfo.mimeType || 'application/octet-stream',
    };
    persistDocumentsMeta();
  }

  // Update local store chunks
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const embedding = embeddings[i] || [];

    const existingIdx = localStore.chunks.findIndex((c) => c.chunkId === chunk.chunkId);
    const chunkRecord = {
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      filename: chunk.filename,
      page: chunk.page,
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      tokenCount: chunk.tokenCount,
      embedding,
    };

    if (existingIdx >= 0) {
      localStore.chunks[existingIdx] = chunkRecord;
    } else {
      localStore.chunks.push(chunkRecord);
    }
  }
  persistLocalStore();

  await upsertChunksToChroma(chunks, embeddings);

  return { insertedCount: chunks.length };
}

async function upsertChunksToChroma(chunks, embeddings) {
  if (!isChromaConnected || !chromaCollection || chunks.length === 0) return;
  try {
    await chromaCollection.upsert({
      ids: chunks.map((chunk) => chunk.chunkId),
      embeddings,
      documents: chunks.map((chunk) => chunk.text),
      metadatas: chunks.map((chunk) => ({
        documentId: String(chunk.documentId),
        filename: String(chunk.filename),
        page: Number(chunk.page),
        chunkIndex: Number(chunk.chunkIndex),
        tokenCount: Number(chunk.tokenCount),
      })),
    });
    console.log(`[ChromaDB] Upserted ${chunks.length} chunks to Chroma collection.`);
  } catch (err) {
    console.warn(`[ChromaDB] Failed to upsert to ChromaDB (${err.message}), local fallback was updated.`);
  }
}

/**
 * Queries similar chunks given a query embedding vector.
 *
 * @param {number[]} queryEmbedding 1536-dimensional query vector
 * @param {number} [topK=5] Number of similar chunks to return
 * @param {string} [filterDocumentId=null] Optional documentId to scope search
 * @returns {Promise<Array<{ chunkId: string, documentId: string, filename: string, page: number, chunkIndex: number, text: string, similarity: number }>>}
 */
async function searchSimilarChunks(queryEmbedding, topK, filterDocumentId, queryText) {
  // If ChromaDB is connected, attempt query via ChromaDB
  if (isChromaConnected && chromaCollection) {
    try {
      const queryParams = {
        queryEmbeddings: [queryEmbedding],
        nResults: Math.min(topK * 4, 100),
      };

      if (filterDocumentId) queryParams.where = { documentId: filterDocumentId };

      const results = await chromaCollection.query(queryParams);

      if (results && results.ids && results.ids[0] && results.ids[0].length > 0) {
        const ids = results.ids[0];
        const documents = results.documents[0];
        const metadatas = results.metadatas[0];
        const distances = results.distances ? results.distances[0] : [];

        const hits = ids.map((id, index) => {
          const dist = distances[index] !== undefined ? distances[index] : 0.5;
          const similarity = Math.max(0, Math.min(1, 1 - dist));
          const meta = metadatas[index] || {};
          return {
            chunkId: id,
            documentId: meta.documentId,
            filename: meta.filename,
            page: meta.page,
            chunkIndex: meta.chunkIndex,
            text: documents[index],
            similarity: Number(similarity.toFixed(4)),
          };
        });

        return rankRetrievedChunks(queryText, hits, topK);
      }
    } catch (err) {
      console.warn(`[ChromaDB] Chroma query failed (${err.message}), evaluating with local cosine store.`);
    }
  }

  // Local fallback: compute cosine similarity against stored chunks
  const candidateChunks = localStore.chunks.filter((chunk) => (
    !filterDocumentId || chunk.documentId === filterDocumentId
  ));

  const scored = candidateChunks.map((chunk) => {
    const sim = cosineSimilarity(queryEmbedding, chunk.embedding);
    return {
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      filename: chunk.filename,
      page: chunk.page,
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      similarity: Number(sim.toFixed(4)),
    };
  });

  return rankRetrievedChunks(queryText, scored, topK);
}

export async function querySimilarChunks(queryEmbedding, topK = 5, filterDocumentId = null, queryText = '') {
  return searchSimilarChunks(queryEmbedding, topK, filterDocumentId, queryText);
}

/**
 * Retrieves all registered documents.
 */
export function getAllDocuments() {
  return Object.values(documentsMeta)
    .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())
    .map(({ ownerId, storedFilename, ...document }) => document);
}

/**
 * Retrieves a single document by ID.
 */
export function getDocumentById(documentId) {
  return documentsMeta[documentId] || null;
}

export function getDocumentChunks(documentId) {
  if (!documentsMeta[documentId]) return [];
  return localStore.chunks
    .filter((chunk) => chunk.documentId === documentId)
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
    .map((chunk) => ({
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      filename: chunk.filename,
      page: chunk.page,
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      tokenCount: chunk.tokenCount,
    }));
}

/**
 * Deletes all chunks and metadata for a document.
 */
export async function deleteDocument(documentId) {
  const existed = Boolean(documentsMeta[documentId]);
  if (!existed) return { success: true, deleted: false };
  delete documentsMeta[documentId];
  persistDocumentsMeta();

  localStore.chunks = localStore.chunks.filter((c) => c.documentId !== documentId);
  persistLocalStore();

  if (isChromaConnected && chromaCollection) {
    try {
      await chromaCollection.delete({
        where: { documentId },
      });
      console.log(`[ChromaDB] Deleted chunks for documentId ${documentId}`);
    } catch (err) {
      console.warn(`[ChromaDB] Chroma delete error: ${err.message}`);
    }
  }

  return { success: true, deleted: existed };
}

/**
 * Returns overall vector store statistics and connectivity.
 */
export function getVectorStoreStats() {
  const allChunks = localStore.chunks;
  return {
    isChromaConnected,
    provider: isChromaConnected ? 'chromadb' : 'local_resilient_store',
    chromaUrl: process.env.CHROMA_URL || 'http://localhost:8000',
    collectionName: process.env.CHROMA_COLLECTION_NAME || 'document_rag_collection',
    totalDocuments: Object.keys(documentsMeta).length,
    totalChunks: allChunks.length,
    totalTokensIndexed: allChunks.reduce((acc, chunk) => acc + (chunk.tokenCount || 0), 0),
  };
}
