// Stamped by the deploy (APP_VERSION build arg); "dev" locally, "main" for build-push.
export function version(): string {
  return process.env.APP_VERSION || 'dev';
}
