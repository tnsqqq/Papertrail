import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const { generateRAGAnswer } = await import('../services/ragService.js');

test('includes the author name and nearby supported background for an author lookup', async () => {
  const result = await generateRAGAnswer({
    query: 'Who is the author of the book?',
    retrievedChunks: [{
      filename: 'book.txt',
      page: 1,
      text: 'Author: Jane Austen. She was an English novelist born in 1775. She wrote Pride and Prejudice.',
    }],
  });

  assert.match(result.answer, /^Jane Austen\./);
  assert.match(result.answer, /English novelist born in 1775/);
  assert.match(result.answer, /Pride and Prejudice/);
});

test('keeps specific fallback answers to at most two relevant sentences', async () => {
  const result = await generateRAGAnswer({
    query: 'Where does the story take place?',
    retrievedChunks: [{
      filename: 'book.txt',
      page: 1,
      text: 'The story takes place in a small village in England. The village is beside a river. The author was born in London.',
    }],
  });

  assert.equal(result.answer, 'The story takes place in a small village in England.');
});

test('provides five or six relevant lines for fallback summaries', async () => {
  const result = await generateRAGAnswer({
    query: 'Summarize the key points.',
    retrievedChunks: [{
      filename: 'notes.txt',
      page: 1,
      text: 'Point one is important. Point two is useful. Point three is clear. Point four is concise. Point five is final. Point six is extra.',
    }],
  });

  assert.ok(result.answer.split('\n').length >= 5 && result.answer.split('\n').length <= 6);
  assert.ok(result.answer.split('\n').every((line) => line.startsWith('- ')));
});

test('gives broader conceptual questions more than a one-line answer', async () => {
  const result = await generateRAGAnswer({
    query: 'What are human behaviors?',
    retrievedChunks: [{
      filename: 'notes.txt',
      page: 1,
      text: 'Human behavior includes the actions and reactions people show in different situations. Human behavior is shaped by emotions, culture, and social surroundings. Human behavior can be learned by observing patterns over time.',
    }],
  });

  assert.ok(result.answer.split(/(?<=[.!?])\s+/).length >= 3);
});

const bookAnswerCases = [
  {
    name: 'identifies William J. Fielding as the author',
    query: 'Who is the author?',
    text: 'Title: Psycho-analysis: The key to human behavior\nAuthor: William J. Fielding\nEditor: E. Haldeman-Julius',
    expected: ['William J. Fielding'],
  },
  {
    name: 'explains the two stated functions of psycho-analysis',
    query: 'What are the two functions of psycho-analysis?',
    text: 'Psycho-analysis has a two-fold value. First, it offers possibilities as a therapeutic or curative agency for many baffling diseases. The second function of psycho-analysis is as a cultural study for the self-improvement and development of the individual.',
    expected: ['therapeutic or curative', 'cultural study', 'self-improvement'],
  },
  {
    name: 'distinguishes manifest and latent dream content',
    query: 'What are manifest and latent dream content?',
    text: 'The version of a dream that is remembered is termed the manifest content, and the wish concealed in the underlying thoughts which produced the dream is known as the latent content.',
    expected: ['manifest content', 'latent content', 'wish concealed'],
  },
];

for (const evaluationCase of bookAnswerCases) {
  test(`book QA: ${evaluationCase.name}`, async () => {
    const result = await generateRAGAnswer({
      query: evaluationCase.query,
      retrievedChunks: [{ filename: 'book.txt', page: 1, text: evaluationCase.text }],
    });

    assert.equal(result.provider, 'local_extractive');
    for (const phrase of evaluationCase.expected) {
      assert.ok(
        result.answer.toLowerCase().includes(phrase.toLowerCase()),
        `Expected answer to include "${phrase}", got: ${result.answer}`
      );
    }
  });
}

test('book QA: summary includes key introduction points in five or six lines', async () => {
  const result = await generateRAGAnswer({
    query: 'Summarize the main ideas.',
    retrievedChunks: [{
      filename: 'book.txt',
      page: 1,
      text: [
        'Psycho-analysis has a two-fold value which places it in the front ranks of the modern constructive sciences.',
        'First, it offers untold possibilities, which are only beginning to be realized, as a therapeutic or curative agency for many baffling diseases.',
        'The second, and in a way the greater, function of psycho-analysis is as a cultural study for the self-improvement and development of the individual.',
        'Psycho-analysis has revolutionized our former conception of human behavior.',
        'It has re-interpreted, and thrown a vastly different light on the passions, loves, hates, fears and other primitive emotions of man.',
        'It has revealed in a startling way many of the heretofore inexplicable motives and actions of individuals.',
      ].join(' '),
    }],
  });

  const lines = result.answer.split('\n');
  assert.ok(lines.length >= 5 && lines.length <= 6);
  assert.ok(lines.every((line) => line.startsWith('- ')));
  assert.match(result.answer, /therapeutic or curative agency/i);
  assert.match(result.answer, /cultural study/i);
  assert.match(result.answer, /human behavior/i);
});

test('book QA: admits when the document does not contain the answer', async () => {
  const result = await generateRAGAnswer({
    query: 'What is the capital of France?',
    retrievedChunks: [{
      filename: 'book.txt',
      page: 1,
      text: 'Psycho-analysis has revolutionized our former conception of human behavior.',
    }],
  });

  assert.match(result.answer, /could not find|not found/i);
});

