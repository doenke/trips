<script lang="ts">
  import { hue, initials } from '../lib/format';
  import type { User } from '../lib/types';

  let { user, size = 32 }: { user: Pick<User, 'id' | 'name' | 'avatar'>; size?: number } = $props();
  let failed = $state(false);
</script>

{#if user.avatar && !failed}
  <img class="avatar" src={user.avatar} alt={user.name} title={user.name} width={size} height={size} style:width="{size}px" style:height="{size}px" onerror={() => (failed = true)} />
{:else}
  <span
    class="avatar initials"
    title={user.name}
    aria-label={user.name}
    style:width="{size}px"
    style:height="{size}px"
    style:font-size="{Math.round(size * 0.4)}px"
    style:--h={hue(user.id)}>{initials(user.name)}</span
  >
{/if}

<style>
  .avatar {
    border-radius: 50%;
    flex: none;
    object-fit: cover;
    border: 2px solid var(--card);
    background: var(--bg-2);
  }
  .initials {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    color: hsl(var(--h) 45% 28%);
    background: hsl(var(--h) 55% 86%);
  }
  @media (prefers-color-scheme: dark) {
    .initials {
      color: hsl(var(--h) 60% 85%);
      background: hsl(var(--h) 30% 28%);
    }
  }
</style>
