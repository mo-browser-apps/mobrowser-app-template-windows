import path from 'path';
import { defineConfig, type UserConfig } from 'vite';

export default defineConfig(({ mode }) => {
  if (mode === 'main') {
    return defineMainConfig();
  }
  throw new Error(`Unsupported Vite config mode: ${mode}`);
});

function defineMainConfig(): UserConfig {
  return {
    root: path.resolve(import.meta.dirname, './src/main'),
    build: {
      target: 'esnext',
      outDir: path.resolve(import.meta.dirname, './out/main'),
      emptyOutDir: true,
      sourcemap: true,
      lib: {
        entry: path.resolve(import.meta.dirname, './src/main/index.ts'),
        formats: ['es'],
        fileName: () => 'index.js',
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src/main'),
      },
    },
    server: {
      forwardConsole: {
        unhandledErrors: true,
        logLevels: ['warn', 'error'],
      },
    },
  };
}
