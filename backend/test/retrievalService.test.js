import test from 'node:test';
import assert from 'node:assert/strict';
import { rankRetrievedChunks } from '../services/retrievalService.js';

test('lexical reranking promotes a matching passage over a higher vector-only hit', () => {
  const chunks = [
    {
      chunkId: 'vector',
      text: 'Dream imagery can encode hidden wishes.',
      similarity: 0.72,
    },
    {
      chunkId: 'lexical',
      text: 'Psycho-analysis interprets dreams to uncover unconscious wishes.',
      similarity: 0.55,
    },
  ];

  const results = rankRetrievedChunks('How does psychoanalysis interpret dreams?', chunks, 1);

  assert.deepEqual(results.map((chunk) => chunk.chunkId), ['lexical']);
});

test('preserves vector ranking when the query has no meaningful lexical terms', () => {
  const chunks = [
    { chunkId: 'lower', text: 'Some passage.', similarity: 0.3 },
    { chunkId: 'higher', text: 'Another passage.', similarity: 0.8 },
  ];

  const results = rankRetrievedChunks('How is it?', chunks, 2);

  assert.deepEqual(results.map((chunk) => chunk.chunkId), ['higher', 'lower']);
});

test('keeps the original chunk data and respects the requested result count', () => {
  const chunks = [
    { chunkId: 'first', text: 'Psycho-analysis and dreams.', page: 2, similarity: 0.7 },
    { chunkId: 'second', text: 'Psycho-analysis and behavior.', page: 4, similarity: 0.6 },
  ];

  const results = rankRetrievedChunks('psychoanalysis dreams', chunks, 1);

  assert.deepEqual(results, [chunks[0]]);
  assert.equal(results[0].page, 2);
});
