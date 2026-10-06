<script lang="ts">
  // The sign-in page: the Google button only (spec §16).
</script>

<main class="signin">
  <div class="card">
    <h1>cams-admin</h1>
    <p class="muted">Account and configuration management for the camera fleet. System administrators only.</p>
    <a class="btn primary" href="/auth/google/login" data-testid="signin-google">Sign in with Google</a>
  </div>
</main>
<style>
  .signin { max-width: 26rem; margin: 15vh auto; padding: 0 16px; }
  .card { display: grid; gap: 12px; }
  h1 { margin: 0; }
  a.btn { text-align: center; text-decoration: none; padding: 10px; }
</style>
