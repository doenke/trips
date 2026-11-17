import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
  compilerOptions: {
    // Forms copy their props into local state on purpose (edit a copy, save explicitly).
    warningFilter: (w) => w.code !== 'state_referenced_locally',
  },
};
