import { exportPages } from './export.js';

function millisecondsUntilNextRun(hour = 2) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function startNightlyExport() {
  let timer;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        const result = await exportPages();
        console.log(`Nightly Markdown export wrote ${result.count} page(s) to ${result.directory}.`);
      } catch (error) {
        console.error('Nightly Markdown export failed:', error);
      } finally {
        schedule();
      }
    }, millisecondsUntilNextRun());
    timer.unref?.();
  };
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
