import { getVectorStoreStats } from '../services/chromaService.js';
import { isOpenAIConfigured } from '../services/embeddingService.js';

export function getSystemStatus(req, res) {
  try {
    const vectorStats = getVectorStoreStats();
    const openAIConfigured = isOpenAIConfigured();
    const geminiConfigured = Boolean(process.env.GEMINI_API_KEY?.trim());
    const answerProvider = geminiConfigured ? 'gemini' : openAIConfigured ? 'openai' : 'local_extractive';

    return res.json({
      success: true,
      status: 'operational',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      vectorStore: vectorStats,
      ai: {
        isOpenAIConfigured: openAIConfigured,
        isGeminiConfigured: geminiConfigured,
        answerProvider,
        chatModel: geminiConfigured
          ? process.env.GEMINI_CHAT_MODEL || 'gemini-1.5-flash'
          : process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
        embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
        embeddingProvider: openAIConfigured && process.env.EMBEDDING_PROVIDER !== 'local_test'
          ? 'openai'
          : 'local_deterministic',
      },
      server: {
        port: Number(process.env.PORT || 5000),
        nodeVersion: process.version,
      },
    });
  } catch (error) {
    console.error('[Status Error]', error);
    return res.status(500).json({
      success: false,
      error: 'Could not retrieve system status.',
    });
  }
}
