import { v4 as uuidv4 } from 'uuid';

/**
 * Splits text into sentences using punctuation boundaries.
 */
function splitIntoSentences(text) {
  if (!text) return [];
  // Normalize line endings and extra whitespace
  const normalized = text.replace(/\r\n/g, '\n').replace(/\t/g, ' ');
  // Split on double newlines (paragraphs) or sentence ending punctuation followed by whitespace
  const rawSegments = normalized.split(/(?<=[.?!])\s+(?=[A-Z0-9"']|\n)/g);

  const cleanSegments = [];
  for (const seg of rawSegments) {
    const trimmed = seg.trim();
    if (trimmed.length > 0) {
      cleanSegments.push(trimmed);
    }
  }
  return cleanSegments;
}

/**
 * Estimates token count based on common 4 characters ~ 1 token heuristic.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Chunks an extracted document into overlapping text segments with rich metadata.
 *
 * @param {Object} docData Extracted document object
 * @param {Array<{ pageNumber: number, text: string }>} docData.pages
 * @param {string} documentId Unique document ID
 * @param {string} filename Original document filename
 * @param {Object} [options]
 * @param {number} [options.maxTokens=600] Maximum tokens per chunk (~2400 chars)
 * @param {number} [options.overlapTokens=120] Overlap tokens between chunks (~480 chars)
 * @returns {Array<{ chunkId: string, documentId: string, filename: string, page: number, chunkIndex: number, text: string, tokenCount: number }>}
 */
export function chunkDocument(docData, documentId, filename, options = {}) {
  const maxTokens = Number.isInteger(options.maxTokens) && options.maxTokens > 0 ? options.maxTokens : 600;
  const overlapTokens = Number.isInteger(options.overlapTokens) && options.overlapTokens >= 0 ? options.overlapTokens : 120;
  const maxChars = maxTokens * 4;
  const overlapChars = Math.min(overlapTokens * 4, maxChars - 1);

  const chunks = [];
  let globalChunkIndex = 0;

  for (const pageObj of docData.pages) {
    const pageNumber = pageObj.pageNumber || 1;
    const pageText = (pageObj.text || '').trim();

    if (!pageText) continue;

    const sentences = splitIntoSentences(pageText);
    let currentChunkSentences = [];
    let currentChunkLength = 0;

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      const sentenceLength = sentence.length;

      // If a single sentence exceeds maxChars, break it down by words
      if (sentenceLength > maxChars) {
        // Flush any accumulated sentences first
        if (currentChunkSentences.length > 0) {
          const chunkText = currentChunkSentences.join(' ').trim();
          chunks.push({
            chunkId: uuidv4(),
            documentId,
            filename,
            page: pageNumber,
            chunkIndex: globalChunkIndex++,
            text: chunkText,
            tokenCount: estimateTokens(chunkText),
          });
          currentChunkSentences = [];
          currentChunkLength = 0;
        }

        // Split long sentence by word boundary
        const words = sentence.split(/\s+/);
        let subChunkWords = [];
        let subChunkLength = 0;

        for (const word of words) {
          if (word.length > maxChars) {
            if (subChunkWords.length > 0) {
              const chunkText = subChunkWords.join(' ');
              chunks.push({
                chunkId: uuidv4(),
                documentId,
                filename,
                page: pageNumber,
                chunkIndex: globalChunkIndex++,
                text: chunkText,
                tokenCount: estimateTokens(chunkText),
              });
              subChunkWords = [];
              subChunkLength = 0;
            }

            for (let start = 0; start < word.length; start += maxChars) {
              const chunkText = word.slice(start, start + maxChars);
              chunks.push({
                chunkId: uuidv4(),
                documentId,
                filename,
                page: pageNumber,
                chunkIndex: globalChunkIndex++,
                text: chunkText,
                tokenCount: estimateTokens(chunkText),
              });
            }
            continue;
          }

          if (subChunkLength + word.length + 1 > maxChars && subChunkWords.length > 0) {
            const chunkText = subChunkWords.join(' ');
            chunks.push({
              chunkId: uuidv4(),
              documentId,
              filename,
              page: pageNumber,
              chunkIndex: globalChunkIndex++,
              text: chunkText,
              tokenCount: estimateTokens(chunkText),
            });
            const overlapWordCount = Math.min(
              Math.floor(overlapChars / 6),
              Math.max(subChunkWords.length - 1, 0)
            );
            subChunkWords = overlapWordCount > 0 ? subChunkWords.slice(-overlapWordCount) : [];
            subChunkLength = subChunkWords.join(' ').length;
          }
          subChunkWords.push(word);
          subChunkLength += word.length + 1;
        }

        if (subChunkWords.length > 0) {
          const chunkText = subChunkWords.join(' ');
          chunks.push({
            chunkId: uuidv4(),
            documentId,
            filename,
            page: pageNumber,
            chunkIndex: globalChunkIndex++,
            text: chunkText,
            tokenCount: estimateTokens(chunkText),
          });
        }
        continue;
      }

      // If adding this sentence exceeds maxChars, finalize current chunk
      if (currentChunkLength + sentenceLength + 1 > maxChars && currentChunkSentences.length > 0) {
        const chunkText = currentChunkSentences.join(' ').trim();
        chunks.push({
          chunkId: uuidv4(),
          documentId,
          filename,
          page: pageNumber,
          chunkIndex: globalChunkIndex++,
          text: chunkText,
          tokenCount: estimateTokens(chunkText),
        });

        // Compute overlap: keep trailing sentences that fit within overlapChars
        const overlapSentences = [];
        let accumulatedOverlap = 0;
        for (let j = currentChunkSentences.length - 1; j >= 0; j--) {
          const s = currentChunkSentences[j];
          if (accumulatedOverlap + s.length <= overlapChars) {
            overlapSentences.unshift(s);
            accumulatedOverlap += s.length;
          } else {
            break;
          }
        }

        currentChunkSentences = overlapSentences;
        currentChunkLength = accumulatedOverlap;
      }

      currentChunkSentences.push(sentence);
      currentChunkLength += sentenceLength + 1;
    }

    // Flush any remaining sentences on the page
    if (currentChunkSentences.length > 0) {
      const chunkText = currentChunkSentences.join(' ').trim();
      if (chunkText.length > 0) {
        chunks.push({
          chunkId: uuidv4(),
          documentId,
          filename,
          page: pageNumber,
          chunkIndex: globalChunkIndex++,
          text: chunkText,
          tokenCount: estimateTokens(chunkText),
        });
      }
    }
  }

  return chunks;
}
