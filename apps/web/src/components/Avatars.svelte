<script lang="ts">
  import type { User } from '../lib/types';
  import Avatar from './Avatar.svelte';

  let { users, size = 28 }: { users: User[]; size?: number } = $props();
</script>

<span class="stack" aria-label={users.map((u) => u.name).join(', ')}>
  {#each users as u (u.id)}
    <Avatar user={u} {size} />
  {/each}
</span>

<style>
  .stack {
    display: inline-flex;
    align-items: center;
  }
  .stack :global(.avatar + .avatar) {
    margin-left: -8px;
  }
</style>
