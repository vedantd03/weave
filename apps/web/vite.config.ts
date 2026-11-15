import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import enginePkg from '../../packages/engine/package.json' with { type: 'json' };

// Typed without @types/node (not an approved dependency); vite.config runs in Node.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const commit = (env.VERCEL_GIT_COMMIT_SHA ?? env.WEAVE_COMMIT ?? 'local').slice(0, 7);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __WEAVE_COMMIT__: JSON.stringify(commit), __WEAVE_ENGINE_VERSION__: JSON.stringify(enginePkg.version) },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
});
