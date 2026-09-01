/**
 * Small text helpers shared by every narrator module — trimming a model's
 * stray formatting and filling `{{key}}` placeholders in a prompt template.
 * Kept in one place so the room narrator, the translator and the outcome
 * narrator never drift on what "clean" means.
 */

import type { TranscriptEntry } from '../game/game';

/** How many recent turns of transcript a narration packet's history tier carries. */
export const HISTORY_WINDOW = 6;

/** `> input\noutput` blocks for the last `window` transcript entries, oldest first. */
export function formatHistory(history: readonly TranscriptEntry[], window = HISTORY_WINDOW): string {
  const recent = history
    .slice(-window)
    .map((entry) => `> ${entry.input}\n${entry.output}`)
    .join('\n\n');
  return recent || '(nothing yet)';
}

/** Trim wrapping quotes and code fences a model sometimes adds around prose. */
export function clean(text: string): string {
  return text
    .trim()
    .replace(/^```[a-z]*\n?|\n?```$/g, '')
    .replace(/^["'“]|["'”]$/g, '')
    .trim();
}

/** `{{key}}` substitution. A missing key is left as-is, which shows up loudly in output. */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => vars[key] ?? whole);
}
