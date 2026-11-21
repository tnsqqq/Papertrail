import dotenv from 'dotenv';
import OpenAI from 'openai';
import crypto from 'crypto';

dotenv.config();

let openaiClient = null;

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!openaiClient && apiKey?.startsWith('sk-')) {
    openaiClient = new OpenAI({
      apiKey,
    });
  }
  return openaiClient;
}

/**
 * Deterministic 1536-dimensional local vector generator for testing and offline environments.
 * Uses term-frequency hashing over words and character n-grams to produce normalized unit vectors.
 */
function generateLocalDeterministicEmbedding(text, dimensions = 1536) {
  const vector = new Array(dimensions).fill(0);
  if (!text || text.trim() === '') {
    return vector;
  }

  const cleanText = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const tokens = cleanText.split(/\s+/).filter((t) => t.length > 0);

  // Bag of words & bigrams hashing
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i];
    const hash = crypto.createHash('sha256').update(word).digest();
    const index = hash.readUInt16BE(0) % dimensions;
    const sign = (hash.readUInt8(2) % 2 === 0) ? 1 : -1;
    vector[index] += sign * (1.0 + Math.log(1 + (word.length / 5)));

    // Bigram
    if (i < tokens.length - 1) {
      const bigram = `${word}_${tokens[i + 1]}`;
      const biHash = crypto.createHash('sha256').update(bigram).digest();
      const biIndex = biHash.readUInt16BE(0) % dimensions;
      const biSign = (biHash.readUInt8(2) % 2 === 0) ? 1 : -1;
      vector[biIndex] += biSign * 1.5;
    }
  }

  // L2 normalize vector
  let sumSq = 0;
  for (let i = 0; i < dimensions; i++) {
    sumSq += vector[i] * vector[i];
  }
  const norm = Math.sqrt(sumSq) || 1.0;
  for (let i = 0; i < dimensions; i++) {
    vector[i] = vector[i] / norm;
  }

  return vector;
}

/**
 * Checks whether active OpenAI API key is configured.
 */
export function isOpenAIConfigured() {
  const key = process.env.OPENAI_API_KEY;
  return Boolean(key && key.trim().startsWith('sk-') && !key.includes('your_api_key'));
}

/**
 * Generates an embedding for a single text query.
 * @param {string} text
 * @returns {Promise<{ embedding: number[] }>}
 */
export async function generateQueryEmbedding(text) {
  const model = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
  const client = getOpenAIClient();

  if (client && isOpenAIConfigured() && process.env.EMBEDDING_PROVIDER !== 'local_test') {
    try {
      const response = await client.embeddings.create({
        model,
        input: text.trim(),
      });
      return { embedding: response.data[0].embedding };
    } catch (err) {
      console.warn(`[EmbeddingService] OpenAI embedding failed (${err.message}). Falling back to local test vector.`);
      return { embedding: generateLocalDeterministicEmbedding(text) };
    }
  }

  return { embedding: generateLocalDeterministicEmbedding(text) };
}

/**
 * Generates embeddings for an array of text chunks (with batching).
 * @param {string[]} texts
 * @returns {Promise<{ embeddings: number[][] }>}
 */
export async function generateBatchEmbeddings(texts) {
  if (!texts || texts.length === 0) return { embeddings: [] };

  const model = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
  const client = getOpenAIClient();

  if (client && isOpenAIConfigured() && process.env.EMBEDDING_PROVIDER !== 'local_test') {
    const BATCH_SIZE = 50;
    const allEmbeddings = [];
    try {
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        const response = await client.embeddings.create({
          model,
          input: batch.map((t) => t.trim() || ' '),
        });
        for (const item of response.data) {
          allEmbeddings.push(item.embedding);
        }
      }

      return { embeddings: allEmbeddings };
    } catch (err) {
      console.warn(`[EmbeddingService] OpenAI batch embedding failed (${err.message}). Falling back to local test vectors.`);
      return { embeddings: texts.map((t) => generateLocalDeterministicEmbedding(t)) };
    }
  }

  return { embeddings: texts.map((t) => generateLocalDeterministicEmbedding(t)) };
}
