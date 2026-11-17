import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';

declare global {
  const __APP_VERSION__: string;
}

mount(App, { target: document.getElementById('app')! });

// Service worker: silent updates, no "new version" banner.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
