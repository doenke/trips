<script lang="ts">
  import { onMount } from 'svelte';
  import DropImport from './components/DropImport.svelte';
  import Home from './components/Home.svelte';
  import Login from './components/Login.svelte';
  import Settings from './components/Settings.svelte';
  import TripPage from './components/TripPage.svelte';
  import { ApiError, get } from './lib/api';
  import { app } from './lib/state.svelte';
  import type { AuthConfig, Me, User } from './lib/types';

  let ready = $state(false);
  let failure = $state('');

  async function boot() {
    failure = '';
    try {
      app.config = await get<AuthConfig>('/auth/config').catch(() => app.config);
      app.me = await get<Me>('/api/me');
      app.users = await get<User[]>('/api/users').catch(() => []);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) failure = (err as Error).message;
      app.me = null;
    } finally {
      ready = true;
    }
  }

  onMount(() => {
    void boot();
    const onPop = () => (app.path = location.pathname);
    const onOnline = () => (app.online = true);
    const onOffline = () => (app.online = false);
    window.addEventListener('popstate', onPop);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  });

  const tripId = $derived(/^\/trips\/([^/]+)$/.exec(app.path)?.[1] ?? null);
</script>

{#if !app.online}<div class="offline-bar">Offline – du siehst den zuletzt geladenen Stand.</div>{/if}

{#if !ready}
  <div class="page"><p class="muted">Lädt …</p></div>
{:else if failure && !app.me}
  <div class="page stack">
    <p class="error">{failure}</p>
    <button onclick={boot}>Noch einmal versuchen</button>
  </div>
{:else if !app.me}
  <Login onlogin={boot} />
{:else if app.path === '/settings'}
  <Settings />
{:else if tripId && tripId !== 'new'}
  {#key tripId}<TripPage id={tripId} />{/key}
{:else}
  <Home creating={tripId === 'new'} />
{/if}

{#if app.me}<DropImport />{/if}

{#if app.toast}<div class="toast" role="status">{app.toast}</div>{/if}
