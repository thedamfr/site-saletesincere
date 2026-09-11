try {
  const response = await fetch('http://127.0.0.1:3000/health', { signal: AbortSignal.timeout(2000) });
  const health = await response.json();
  if (!response.ok || health.mode !== 'normal' || health.database?.state !== 'read_write' || health.episodeWorker?.state !== 'ready') process.exit(1);
} catch { process.exit(1); }
