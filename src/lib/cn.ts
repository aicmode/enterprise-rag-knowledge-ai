/**
 * Minimal class-name joiner.
 *
 * Deliberately not `clsx` + `tailwind-merge`: this app has a small, controlled
 * set of components and does not need conflict resolution, so a five-line
 * helper avoids two more dependencies.
 */
export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}
