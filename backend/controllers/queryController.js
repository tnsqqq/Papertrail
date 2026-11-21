import { generateQueryEmbedding } from '../services/embeddingService.js';
import { getDocumentById, querySimilarChunks } from '../services/chromaService.js';
import { generateRAGAnswer, streamRAGAnswer } from '../services/ragService.js';

const configuredTopK = Number(process.env.TOP_K || 5);
const DEFAULT_TOP_K = Number.isFinite(configuredTopK) && configuredTopK > 0 ? configuredTopK : 5;
function getTopK(value) {
  const requestedTopK = Number(value);
  const topK = Number.isFinite(requestedTopK) && requestedTopK > 0 ? requestedTopK : DEFAULT_TOP_K;
  return Math.max(1, Math.min(topK, 20));
}

/**
 * Handles standard JSON question answering over documents.
 */
export async function askQuestion(req, res) {
  try {
    const { query, documentId = null, topK } = req.body || {};

    if (typeof query !== 'string' || query.trim().length === 0 || query.length > 2000) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a question between 1 and 2000 characters.',
      });
    }
    if (documentId !== null && typeof documentId !== 'string') {
      return res.status(400).json({ success: false, error: 'documentId must be a string or null.' });
    }
    if (documentId && !getDocumentById(documentId)) {
      return res.status(404).json({ success: false, error: 'Document not found.' });
    }

    const parsedTopK = getTopK(topK);

    // 1. Generate embedding for user query
    const { embedding: queryVector } = await generateQueryEmbedding(query.trim());

    // 2. Retrieve top-k most relevant chunks
    const retrievedChunks = await querySimilarChunks(queryVector, parsedTopK, documentId || null, query.trim());

    // 3. Generate synthesized answer with citations
    const result = await generateRAGAnswer({
      query: query.trim(),
      retrievedChunks,
    });
    return res.json({
      success: true,
      query: query.trim(),
      answer: result.answer,
      provider: result.provider,
      model: result.model || null,
      sources: result.sources || [],
      metadata: {
        provider: result.provider,
        model: result.model,
        retrievedCount: retrievedChunks.length,
        filterDocumentId: documentId || null,
      },
    });
  } catch (error) {
    console.error('[Query Error]', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to answer the question. Please try again.',
    });
  }
}

/**
 * Handles streaming Server-Sent Events (SSE) question answering.
 */
export async function askQuestionStream(req, res) {
  try {
    const { query, documentId = null, topK } = req.body || {};

    if (typeof query !== 'string' || query.trim().length === 0 || query.length > 2000) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a question between 1 and 2000 characters.',
      });
    }
    if (documentId !== null && typeof documentId !== 'string') {
      return res.status(400).json({ success: false, error: 'documentId must be a string or null.' });
    }
    if (documentId && !getDocumentById(documentId)) {
      return res.status(404).json({ success: false, error: 'Document not found.' });
    }

    const parsedTopK = getTopK(topK);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // 1. Embed query
    const { embedding: queryVector } = await generateQueryEmbedding(query.trim());

    // 2. Retrieve chunks
    const retrievedChunks = await querySimilarChunks(queryVector, parsedTopK, documentId || null, query.trim());

    // Send retrieved sources first
    res.write(`data: ${JSON.stringify({ type: 'sources', sources: retrievedChunks })}\n\n`);

    // 3. Stream generated answer
    await streamRAGAnswer({
      query: query.trim(),
      retrievedChunks,
      onToken: (token) => {
        res.write(`data: ${JSON.stringify({ type: 'token', content: token })}\n\n`);
      },
      onDone: (result) => {
        res.write(`data: ${JSON.stringify({ type: 'done', answer: result.answer, provider: result.provider })}\n\n`);
        res.end();
      },
      onError: () => {
        res.write(`data: ${JSON.stringify({ type: 'error', error: 'Failed to answer the question. Please try again.' })}\n\n`);
        res.end();
      },
    });
  } catch (error) {
    console.error('[Query Stream Error]', error);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: 'Failed to answer the question. Please try again.' });
    }
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'Failed to answer the question. Please try again.' })}\n\n`);
    res.end();
  }
}
