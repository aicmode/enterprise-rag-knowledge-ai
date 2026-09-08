/**
 * Display formatting helpers.
 *
 * Pure and dependency-free so they can be used from both Server and Client
 * Components and asserted directly in tests.
 */

/** "2.4 MB" - human-readable byte size. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;

  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`;
}

/**
 * "2026/09/08 14:32" - timestamps rendered in a fixed locale and timezone.
 *
 * Locale and timeZone are pinned so the server-rendered string and the
 * client-rendered string are identical; leaving them to the runtime default is
 * a classic source of React hydration mismatches.
 */
export function formatDateTime(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '-';

  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Tokyo',
  }).format(date);
}

/** "1.4秒" - response time in seconds. */
export function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return '-';
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ミリ秒`;
  return `${(milliseconds / 1000).toFixed(1)}秒`;
}

/** Truncate for list previews, adding an ellipsis only when text was removed. */
export function truncate(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}…`;
}

/** "68%" - a 0..1 ratio as a whole-number percentage. */
export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return '-';
  return `${Math.round(ratio * 100)}%`;
}
