import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ breaks: true, gfm: true });

const fileInput = document.getElementById('file-input');
const uploadStatus = document.getElementById('upload-status');
const documentCount = document.getElementById('document-count');
const documentsList = document.getElementById('documents-list');
const libraryEmpty = document.getElementById('library-empty');
const activeScope = document.getElementById('active-scope');
const newChatButton = document.getElementById('new-chat');
const themeToggle = document.getElementById('theme-toggle');
const themeColor = document.querySelector('meta[name="theme-color"]');
const connectionDot = document.getElementById('connection-dot');
const connectionStatus = document.getElementById('connection-status');
const questionForm = document.getElementById('question-form');
const questionInput = document.getElementById('question-input');
const characterCount = document.getElementById('character-count');
const composerHint = document.getElementById('composer-hint');
const askButton = document.getElementById('btn-ask');
const answersContainer = document.getElementById('answers-container');
const welcomeCard = document.getElementById('welcome-card');
const suggestedQuestions = document.querySelectorAll('.suggestion-button');

const allowedAnswerTags = [
  'a', 'blockquote', 'br', 'code', 'em', 'h1', 'h2', 'h3', 'li',
  'ol', 'p', 'pre', 'strong', 'ul',
];
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

function apiUrl(path) {
  return `${apiBaseUrl}${path}`;
}

async function readApiJson(response) {
  const text = await response.text();
  if (!text) throw new Error(`The API returned an empty response (${response.status}).`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`The API returned an invalid response (${response.status}).`);
  }
}

let documents = [];
let activeDocumentId = null;
let isAsking = false;

function applyTheme(theme, persist = false) {
  document.documentElement.dataset.theme = theme;
  themeColor.content = theme === 'dark' ? '#232720' : '#e8ebe6';
  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  const label = `Switch to ${nextTheme} mode`;
  themeToggle.setAttribute('aria-label', label);
  themeToggle.title = label;
  themeToggle.setAttribute('aria-pressed', String(theme === 'dark'));

  if (persist) {
    try {
      localStorage.setItem('papertrail-theme', theme);
    } catch {
      // The selected theme still applies for this session if storage is unavailable.
    }
  }
}

function getInitialTheme() {
  try {
    const savedTheme = localStorage.getItem('papertrail-theme');
    if (savedTheme === 'light' || savedTheme === 'dark') return savedTheme;
  } catch {
    // Fall back to the operating system preference.
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

applyTheme(getInitialTheme());

function setUploadStatus(message, state = '') {
  uploadStatus.textContent = message;
  uploadStatus.className = `upload-status${state ? ` ${state}` : ''}`;
}

function setConnectionStatus(message, isConnected) {
  connectionStatus.textContent = message;
  connectionDot.classList.toggle('is-online', isConnected);
}

function updateComposer() {
  const hasDocuments = documents.length > 0;
  questionInput.disabled = !hasDocuments || isAsking;
  askButton.disabled = !hasDocuments || isAsking || !questionInput.value.trim();
  for (const suggestion of suggestedQuestions) {
    suggestion.disabled = !hasDocuments || isAsking;
  }
  composerHint.textContent = hasDocuments
    ? 'Answers are based on your documents.'
    : 'Upload a document to get started.';
}

function renderDocuments() {
  documentsList.replaceChildren(libraryEmpty);
  documentCount.textContent = String(documents.length);
  libraryEmpty.hidden = documents.length > 0;

  if (documents.length > 0) {
    const allDocumentsButton = document.createElement('button');
    allDocumentsButton.type = 'button';
    allDocumentsButton.className = `document-item all-documents${activeDocumentId === null ? ' is-active' : ''}`;
    allDocumentsButton.setAttribute('aria-pressed', String(activeDocumentId === null));
    allDocumentsButton.innerHTML = '<span class="document-icon all-icon" aria-hidden="true">✳</span>';

    const allCopy = document.createElement('span');
    allCopy.className = 'document-copy';
    const allName = document.createElement('strong');
    allName.textContent = 'All documents';
    const allDetail = document.createElement('small');
    allDetail.textContent = `${documents.length} ${documents.length === 1 ? 'file' : 'files'}`;
    allCopy.append(allName, allDetail);
    allDocumentsButton.append(allCopy);
    allDocumentsButton.addEventListener('click', () => {
      activeDocumentId = null;
      renderDocuments();
      updateComposer();
    });
    documentsList.append(allDocumentsButton);
  }

  for (const doc of documents) {
    const item = document.createElement('div');
    item.className = `document-item${activeDocumentId === doc.id ? ' is-active' : ''}`;

    const selectButton = document.createElement('button');
    selectButton.type = 'button';
    selectButton.className = 'document-select';
    selectButton.setAttribute('aria-pressed', String(activeDocumentId === doc.id));
    selectButton.title = `Use ${doc.filename}`;

    const extension = doc.filename.split('.').pop()?.toUpperCase() || 'DOC';
    const icon = document.createElement('span');
    icon.className = 'document-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = extension.slice(0, 3);

    const copy = document.createElement('span');
    copy.className = 'document-copy';
    const name = document.createElement('strong');
    name.textContent = doc.filename;
    const detail = document.createElement('small');
    const pageCount = doc.numPages || 1;
    detail.textContent = `${pageCount} ${pageCount === 1 ? 'page' : 'pages'} · ${doc.totalChunks || 0} chunks`;
    copy.append(name, detail);
    selectButton.append(icon, copy);
    selectButton.addEventListener('click', () => {
      activeDocumentId = doc.id;
      renderDocuments();
      updateComposer();
    });

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'delete-document';
    deleteButton.setAttribute('aria-label', `Delete ${doc.filename}`);
    deleteButton.title = 'Delete document';
    deleteButton.textContent = '×';
    deleteButton.addEventListener('click', () => deleteDocument(doc));

    item.append(selectButton, deleteButton);
    documentsList.append(item);
  }

  const activeDocument = documents.find((document) => document.id === activeDocumentId);
  if (activeDocumentId && !activeDocument) activeDocumentId = null;
  activeScope.textContent = activeDocument ? activeDocument.filename : 'All documents';
  updateComposer();
}

async function loadDocuments() {
  const response = await fetch(apiUrl('/api/documents'));
  const result = await readApiJson(response);
  if (!response.ok || !result.success) {
    throw new Error(result.error || 'Could not load documents.');
  }

  documents = result.documents;
  renderDocuments();
}

async function checkConnection() {
  try {
    const response = await fetch(apiUrl('/api/status'));
    const result = await readApiJson(response);
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'The API is unavailable.');
    }

    const vectorStore = result.vectorStore?.provider === 'neon_pgvector' ? 'Neon pgvector' : 'Cloud vector index';
    setConnectionStatus(`Public demo connected · ${vectorStore}`, true);
  } catch (error) {
    console.error('Local API connection check failed:', error);
    setConnectionStatus('Could not connect to the API', false);
  }
}

async function uploadDocument(file) {
  if (!file) return;

  const extension = file.name.split('.').pop()?.toLowerCase();
  if (!['pdf', 'txt'].includes(extension)) {
    setUploadStatus('Choose a PDF or TXT file.', 'error');
    fileInput.value = '';
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    setUploadStatus('Files must be 5 MB or smaller.', 'error');
    fileInput.value = '';
    return;
  }

  fileInput.disabled = true;
  setUploadStatus(`Indexing ${file.name}…`, 'loading');

  try {
    const body = new FormData();
    body.append('file', file);
    const response = await fetch(apiUrl('/api/documents/upload'), { method: 'POST', body });
    const result = await readApiJson(response);
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'The document could not be indexed.');
    }

    activeDocumentId = result.document.id;
    await loadDocuments();
    setUploadStatus(`${result.document.filename} is ready to search.`, 'success');
  } catch (error) {
    setUploadStatus(error.message, 'error');
  } finally {
    fileInput.disabled = false;
    fileInput.value = '';
  }
}

async function deleteDocument(document) {
  if (!window.confirm(`Delete "${document.filename}" and its indexed content?`)) return;

  try {
    const response = await fetch(apiUrl(`/api/documents/${encodeURIComponent(document.id)}`), {
      method: 'DELETE',
    });
    const result = await readApiJson(response);
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'The document could not be deleted.');
    }

    if (activeDocumentId === document.id) activeDocumentId = null;
    await loadDocuments();
    setUploadStatus(`${document.filename} was deleted.`, 'success');
  } catch (error) {
    setUploadStatus(error.message, 'error');
  }
}

function createQuestionCard(query) {
  const card = document.createElement('article');
  card.className = 'qa-card';

  const question = document.createElement('p');
  question.className = 'qa-question';
  question.textContent = query;

  const answer = document.createElement('div');
  answer.className = 'qa-answer';
  answer.innerHTML = '<div class="answer-loading"><span class="spinner" aria-hidden="true"></span><span>Searching your documents…</span></div>';

  card.append(question, answer);
  return { card, answer };
}

questionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = questionInput.value.trim();
  if (!query || isAsking || documents.length === 0) return;

  welcomeCard.hidden = true;
  const { card, answer } = createQuestionCard(query);
  answersContainer.append(card);
  newChatButton.hidden = false;
  isAsking = true;
  questionInput.value = '';
  characterCount.textContent = '0 / 2000';
  updateComposer();

  try {
    const response = await fetch(apiUrl('/api/query'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        documentId: activeDocumentId,
        topK: 6,
      }),
    });
    const result = await readApiJson(response);
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Could not find an answer.');
    }

    answer.replaceChildren();
    const answerText = document.createElement('div');
    answerText.className = 'answer-copy';
    answerText.innerHTML = DOMPurify.sanitize(marked.parse(result.answer || 'No answer was returned.'), {
      ALLOWED_TAGS: allowedAnswerTags,
      ALLOWED_ATTR: ['href', 'title'],
    });
    answer.append(answerText);
  } catch (error) {
    answer.classList.add('answer-error');
    answer.textContent = error.message;
  } finally {
    isAsking = false;
    updateComposer();
    questionInput.focus();
  }
});

themeToggle.addEventListener('click', () => {
  const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(nextTheme, true);
});

newChatButton.addEventListener('click', () => {
  for (const card of answersContainer.querySelectorAll('.qa-card')) {
    card.remove();
  }
  welcomeCard.hidden = false;
  newChatButton.hidden = true;
  questionInput.focus();
});

for (const suggestion of suggestedQuestions) {
  suggestion.addEventListener('click', () => {
    questionInput.value = suggestion.dataset.question || '';
    characterCount.textContent = `${questionInput.value.length} / 2000`;
    updateComposer();
    questionForm.requestSubmit();
  });
}

fileInput.addEventListener('change', () => uploadDocument(fileInput.files?.[0]));
questionInput.addEventListener('input', () => {
  characterCount.textContent = `${questionInput.value.length} / 2000`;
  updateComposer();
});
questionInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    questionForm.requestSubmit();
  }
});

async function initializeApp() {
  await Promise.all([
    loadDocuments().catch((error) => {
      console.error('Could not load documents:', error);
      setUploadStatus('Could not load documents. Check that the API is running.', 'error');
    }),
    checkConnection(),
  ]);
}

initializeApp();
