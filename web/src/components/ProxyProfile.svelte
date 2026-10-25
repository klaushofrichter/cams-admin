<script lang="ts">
  // The proxy profile as the proxy reports it (proxy profile design §3): read only, a person sets it on the proxy.
  import { camerasLine, hardwareLine, NO_PROFILE, storageLine, warningText, type Profile } from '../lib/profile';
  import FirewallLines from './FirewallLines.svelte';

  let { profile, unreadable = false, runsOn = '' }: { profile: Profile | null; unreadable?: boolean; runsOn?: string } = $props();
</script>

<section class="card grid" data-testid="profile-card">
  <h3>Profile</h3>
  {#if !profile}
    <p class="muted" data-testid="profile-none">{unreadable ? 'The proxy reported a profile cams-admin could not read.' : NO_PROFILE}</p>
  {:else}
    {#if !profile.set}<p class="badge warn" data-testid="profile-unset">Not set yet: set it on the proxy's home page. Until then it counts the cameras it holds as its capacity.</p>{/if}
    <table>
      <tbody>
        <tr><td>Name</td><td data-testid="profile-name">{profile.name ?? '—'}</td></tr>
        <tr><td>Cameras</td><td data-testid="profile-cameras">{camerasLine(profile)}</td></tr>
        <tr><td>Storage</td><td data-testid="profile-storage">{storageLine(profile)}</td></tr>
        <tr><td>Hardware</td><td data-testid="profile-hardware">{hardwareLine(profile.hardware)} <span class="muted">(as seen by cam-proxy{runsOn === 'cluster' ? ': in the cluster that is the node' : ''})</span></td></tr>
        <tr><td>FTP</td><td data-testid="profile-ftp">{profile.ftp.enabled ? `on, port ${profile.ftp.port ?? '—'}${profile.ftp.passive ? `, passive ${profile.ftp.passive.from}–${profile.ftp.passive.to}` : ''}` : 'off'}</td></tr>
      </tbody>
    </table>
    {#each profile.warnings as w}<p class="badge warn" data-testid="profile-warning-{w}">{warningText(w)}</p>{/each}
    {#if profile.firewall.lines.length}
      <p class="muted">Firewall lines for its cameras{profile.firewall.tool ? ` (${profile.firewall.tool})` : ''}, to run on the proxy's host:</p>
      <FirewallLines lines={profile.firewall.lines} testid="profile-firewall" />
    {/if}
  {/if}
</section>

<style>
  h3 { margin: 0; }
  td:first-child { color: var(--muted); white-space: nowrap; }
  p.badge { white-space: normal; margin: 0; }
</style>
