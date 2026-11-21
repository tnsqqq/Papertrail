import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkDocument } from '../services/chunkingService.js';

function documentWithText(text) {
  return {
    fullText: text,
    pages: [{ pageNumber: 1, text }],
  };
}

test('chunks long text without overlap and keeps chunks within the configured size', () => {
  const chunks = chunkDocument(
    documentWithText('word '.repeat(100)),
    'document-1',
    'notes.txt',
    { maxTokens: 10, overlapTokens: 0 }
  );

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 40));
  assert.equal(chunks[0].page, 1);
});

test('splits a single word that exceeds the maximum chunk size', () => {
  const chunks = chunkDocument(
    documentWithText('x'.repeat(100)),
    'document-1',
    'notes.txt',
    { maxTokens: 10, overlapTokens: 0 }
  );

  assert.deepEqual(chunks.map((chunk) => chunk.text.length), [40, 40, 20]);
});

test('does not create empty chunks for a document without text', () => {
  assert.deepEqual(chunkDocument(documentWithText('  '), 'document-1', 'empty.txt'), []);
});
