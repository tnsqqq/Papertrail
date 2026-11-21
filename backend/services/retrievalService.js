const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'does', 'for', 'from',
  'how', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to',
  'was', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'with',
]);

function tokenize(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[\u2010-\u2015-]/g, '')
      .match(/[a-z0-9]+/g)
      ?.filter((term) => term.length > 2 && !STOP_WORDS.has(term)) || []
  );
}

function lexicalRelevance(queryTerms, text) {
  if (queryTerms.size === 0) return 0;
  const textTerms = tokenize(text);
  let matches = 0;
  for (const term of queryTerms) {
    if (textTerms.has(term)) matches++;
  }
  return matches / queryTerms.size;
}

export function rankRetrievedChunks(query, chunks, topK) {
  const queryTerms = tokenize(query);
  return chunks
    .map((chunk, index) => {
      const vectorScore = Number.isFinite(chunk.similarity)
        ? Math.max(0, Math.min(1, chunk.similarity))
        : 0;
      const lexicalScore = lexicalRelevance(queryTerms, chunk.text || '');

      return {
        chunk,
        index,
        vectorScore,
        rankingScore: vectorScore * 0.75 + lexicalScore * 0.25,
      };
    })
    .sort((a, b) => (
      b.rankingScore - a.rankingScore
      || b.vectorScore - a.vectorScore
      || a.index - b.index
    ))
    .slice(0, topK)
    .map((result) => result.chunk);
}
