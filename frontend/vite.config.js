import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backendUrl = env.VITE_API_TARGET || env.VITE_API_BASE_URL || 'http://127.0.0.1:5000';

  return {
    server: {
      host: '127.0.0.1',
      port: Number(env.VITE_PORT || 3000),
      proxy: {
        '/api': {
          target: backendUrl,
          changeOrigin: true,
        },
        '/health': {
          target: backendUrl,
          changeOrigin: true,
        },
      },
    },
  };
});
