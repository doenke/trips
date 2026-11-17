<script lang="ts">
  import { post } from '../lib/api';
  import { app } from '../lib/state.svelte';

  let { onlogin }: { onlogin: () => void } = $props();
  const params = new URLSearchParams(location.search);
  const code = params.get('login_error');
  const next = params.get('next') ?? (location.pathname !== '/' ? location.pathname : '/');
  let devName = $state('');
  let devAdmin = $state(false);
  let busy = $state(false);
  let devError = $state('');

  const provider = $derived(app.config?.provider ?? 'Kanonenwiese SSO');
  const messages: Record<string, string> = {
    discovery: `{p} ist gerade nicht erreichbar. Bitte versuch es gleich noch einmal.`,
    invalid_client: `{p} kennt diese App nicht oder das Client-Secret passt nicht (invalid_client). Bitte die Client-ID in der Konfiguration prüfen.`,
    invalid_grant: `Die Anmeldung wurde abgelehnt (invalid_grant). Meist passt die Redirect-URI nicht: Beim Client in Pocket ID muss genau {r} eingetragen sein.`,
    expired: 'Die Anmeldung hat zu lange gedauert. Bitte noch einmal.',
    access_denied: `Du hast keinen Zugang zu Trips. Bitte frag nach, ob dein Konto in der richtigen Gruppe bei {p} ist.`,
    state: 'Die Anmeldung ließ sich nicht zuordnen. Bitte noch einmal.',
    provider: `{p} hat die Anmeldung abgelehnt.`,
    failed: 'Die Anmeldung hat nicht geklappt. Bitte noch einmal versuchen.',
  };
  const errorText = $derived(code ? (messages[code] ?? messages.failed!).replaceAll('{p}', provider).replaceAll('{r}', app.config?.redirectUri ?? '…/auth/callback') : '');

  async function devLogin(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    devError = '';
    try {
      await post('/auth/dev', { name: devName, admin: devAdmin });
      history.replaceState(null, '', next);
      onlogin();
    } catch (err) {
      devError = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<main class="login">
  <div class="card pad stack">
    <div class="brand"><img src="/icon-192.png" alt="" /> Trips</div>
    <p>Deine Reisen und Buchungen an einem Ort – Flüge, Züge, Hotels, Mietwagen und Parkplätze, auch offline auf dem Handy.</p>
    {#if errorText}<p class="error">{errorText}</p>{/if}
    {#if app.config?.oidc}
      <a class="button primary full" href="/auth/login?next={encodeURIComponent(next)}">Mit {provider} anmelden</a>
    {:else}
      <p class="notice">Die Anmeldung ist noch nicht eingerichtet (OIDC_ISSUER und OIDC_CLIENT_ID fehlen).</p>
    {/if}
    {#if app.config?.devLogin}
      <form class="dev stack" onsubmit={devLogin}>
        <p class="small"><strong>DEV_LOGIN</strong> ist aktiv – nur für die Entwicklung, nie in Produktion.</p>
        <div class="field">
          <label for="dev-name">Name</label>
          <input id="dev-name" bind:value={devName} required autocomplete="off" />
        </div>
        <label class="row"><input type="checkbox" bind:checked={devAdmin} style="width:auto;min-height:0" /> Admin</label>
        {#if devError}<p class="error">{devError}</p>{/if}
        <button disabled={busy || !devName.trim()}>Ohne Passwort anmelden</button>
      </form>
    {/if}
  </div>
</main>

<style>
  .login {
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .login .card {
    width: 100%;
    max-width: 400px;
  }
  .full {
    width: 100%;
  }
  .dev {
    border-top: 1px dashed var(--line);
    padding-top: 12px;
  }
</style>
