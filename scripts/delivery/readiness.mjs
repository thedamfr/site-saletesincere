import { pathToFileURL } from 'node:url';

// Routing readiness is intentionally independent of PostgreSQL and pg-boss.
// Delivery smoke checks still require normal/read_write/ready before acceptance.
export async function checkReadiness({ fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${process.env.PORT || 3000}/health`, {
      signal: AbortSignal.timeout(2000)
    });
    const health = await response.json();
    return response.ok && health.ok === true;
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await checkReadiness() ? 0 : 1;
}
