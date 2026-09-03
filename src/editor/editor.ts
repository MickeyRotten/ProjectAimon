/**
 * Aimon data editor — a dev-only tool for editing the JSON tables.
 *
 * Served by `npm run dev` at /editor.html; never part of the production build.
 * Loads files with fetch() (the dev server serves the repo root), renders them
 * generically — arrays of records as table rows, maps as field lists, string
 * arrays as editable lists — and writes edits back in place via the File
 * System Access API (PC Chromium only; read-only elsewhere).
 *
 * It is no longer schema-blind. Three things sit on top of the generic renderer,
 * all in service of a non-programmer editing content safely (TODO task 4):
 *
 *  - **Live validation.** Every edit re-runs the engine's own cross-reference
 *    checker (`validateCampaign`, via `validation.ts`) over the unsaved files.
 *    Each issue is anchored to the exact field it names — the renderer stamps a
 *    `data-path` on every control matching the validator's own path strings —
 *    and also listed in a sidebar. This is the "dependencies marked clearly /
 *    error prevention" ask, using a checker that already existed.
 *  - **Closed-vocabulary pickers.** Tag fields autocomplete against `tags.json`,
 *    so a bad tag is hard to type in the first place rather than merely caught
 *    after.
 *  - **Recovery.** A per-file Revert discards unsaved edits back to the loaded
 *    copy, and Save first shows a diff of exactly what will be written to disk.
 */

import { TagVocabulary } from '../engine/tags';
import type { Json } from '../campaign/merge';
import {
  issueBelongsTo,
  pathIsUnder,
  validateFiles,
  type ValidationIssue,
  type ValidationReport,
} from './validation';

// ---------------------------------------------------------------------------
// File manifest
// ---------------------------------------------------------------------------

interface FileEntry {
  /** Path relative to repo root, used for fetch and for writing back. */
  path: string;
  /** Tab label. */
  label: string;
  category: string;
}

const BASE = 'campaigns/base';

const FILES: FileEntry[] = [
  { path: `${BASE}/campaign.json`, label: 'campaign', category: 'Campaign' },
  { path: `${BASE}/rules.json`, label: 'rules', category: 'Rules' },
  { path: `${BASE}/tags.json`, label: 'tags', category: 'Tags' },
  { path: `${BASE}/areas/coven.json`, label: 'coven', category: 'Areas' },
  { path: `${BASE}/areas/farmland.json`, label: 'farmland', category: 'Areas' },
  { path: `${BASE}/areas/ruin.json`, label: 'ruin', category: 'Areas' },
  { path: `${BASE}/areas/town.json`, label: 'town', category: 'Areas' },
  { path: `${BASE}/areas/warren.json`, label: 'warren', category: 'Areas' },
  { path: `${BASE}/content/abilities.json`, label: 'abilities', category: 'Content' },
  { path: `${BASE}/content/adjacency.json`, label: 'adjacency', category: 'Content' },
  { path: `${BASE}/content/items.json`, label: 'items', category: 'Content' },
  { path: `${BASE}/content/monsters.json`, label: 'monsters', category: 'Content' },
  { path: `${BASE}/content/npcs.json`, label: 'npcs', category: 'Content' },
  { path: `${BASE}/content/placement.json`, label: 'placement', category: 'Content' },
  { path: `${BASE}/quests/clear.json`, label: 'clear', category: 'Quests' },
  { path: `${BASE}/quests/deliver.json`, label: 'deliver', category: 'Quests' },
  { path: `${BASE}/quests/fetch.json`, label: 'fetch', category: 'Quests' },
  { path: `${BASE}/quests/find.json`, label: 'find', category: 'Quests' },
  { path: `${BASE}/quests/investigate.json`, label: 'investigate', category: 'Quests' },
  { path: `${BASE}/quests/kill.json`, label: 'kill', category: 'Quests' },
  { path: 'data/verbs.json', label: 'verbs', category: 'Verbs' },
];

const CATEGORIES = [...new Set(FILES.map((f) => f.category))];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface JsonRecord {
  [key: string]: Json;
}

/** File System Access API — not yet in the TS DOM lib. */
declare global {
  interface Window {
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  }
}

const isJsonRecord = (value: Json): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface FileState {
  entry: FileEntry;
  /** Parsed JSON as loaded from disk. */
  original: Json;
  /** Live edited value (mutated in place by the renderer's inputs). */
  current: Json;
  loaded: boolean;
}

const state = new Map<string, FileState>(); // by path
let activeCategory = CATEGORIES[0]!;
let activePath: string | null = null;

/** Latest validation over the live files. Null until the first run finishes. */
let report: ValidationReport | null = null;

/** Directory handle for in-place writes; null until the user picks one. */
let dirHandle: FileSystemDirectoryHandle | null = null;

const TAGS_PATH = `${BASE}/tags.json`;

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadFile(entry: FileEntry): Promise<void> {
  const res = await fetch(`/${entry.path}`);
  if (!res.ok) throw new Error(`${entry.path}: HTTP ${res.status}`);
  const json: Json = await res.json();
  state.set(entry.path, {
    entry,
    original: structuredClone(json),
    current: json,
    loaded: true,
  });
}

function isDirty(path: string): boolean {
  const file = state.get(path);
  if (!file) return false;
  return JSON.stringify(file.current) !== JSON.stringify(file.original);
}

// ---------------------------------------------------------------------------
// The tag vocabulary — drives autocomplete and the closed-vocabulary pickers.
// ---------------------------------------------------------------------------

let vocabulary = new TagVocabulary({});

function rebuildVocabulary(): void {
  const tags = state.get(TAGS_PATH)?.current;
  vocabulary = new TagVocabulary(tags ?? {});
  const datalist = $('#tag-vocab');
  datalist.replaceChildren(
    ...vocabulary.all().map((tag) => {
      const option = document.createElement('option');
      option.value = tag;
      const ns = vocabulary.namespaceOf(tag);
      if (ns) option.label = ns;
      return option;
    }),
  );
}

/** Keys whose value is a bag of tags — a plain list, no operators. */
const TAG_LIST_KEYS = new Set(['tags', 'areaTags', 'excludeTags']);
/** Keys whose value is a `requires[]` — tags with `!` and `|` operators. */
const REQUIRES_KEYS = new Set(['requires', 'targetTags']);
/** Keys whose value is a single tag. */
const SINGLE_TAG_KEYS = new Set(['kind', 'itemKind']);

// ---------------------------------------------------------------------------
// Saving — File System Access API
// ---------------------------------------------------------------------------

function supportsFsAccess(): boolean {
  return 'showDirectoryPicker' in window;
}

async function pickDirectory(): Promise<void> {
  if (!supportsFsAccess()) {
    setStatus('err', 'File System Access API unavailable in this browser — editor is read-only. Use a Chromium browser on PC.');
    return;
  }
  try {
    dirHandle = await window.showDirectoryPicker!({ mode: 'readwrite' });
    const root = await dirHandle!.getDirectoryHandle('campaigns').catch(() => null);
    if (!root) {
      dirHandle = null;
      setStatus('err', 'That folder has no campaigns/ directory — pick the repo root.');
      return;
    }
    $('#fs-status').textContent = `writing to: ${dirHandle!.name}`;
    $('#fs-status').classList.add('ok');
    setStatus('ok', 'Folder connected. Saves write directly to disk.');
  } catch {
    /* user cancelled */
  }
}

async function saveFile(path: string): Promise<void> {
  const file = state.get(path);
  if (!file) return;
  if (!dirHandle) {
    await pickDirectory();
    if (!dirHandle) return;
  }
  try {
    const parts = path.split('/');
    const name = parts.pop()!;
    let dir = dirHandle;
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(file.current, null, 2) + '\n');
    await writable.close();
    file.original = structuredClone(file.current);
    setStatus('ok', `saved ${path}`);
    renderTabs();
    updateButtons();
  } catch (err) {
    setStatus('err', `save failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Renderer — generic JSON → controls, each stamped with its validator path
// ---------------------------------------------------------------------------

function isRecordArray(value: Json): value is JsonRecord[] {
  return Array.isArray(value) && value.length > 0 && value.every(isJsonRecord);
}

/** Stamp a control with the validator path it lives at, so a badge can find it. */
function stamp(el: HTMLElement, path: string): HTMLElement {
  el.dataset['path'] = path;
  return el;
}

function renderValue(value: Json, path: string, onChange: () => void): HTMLElement {
  if (typeof value === 'boolean') return renderCheckbox(value, onChange);
  if (typeof value === 'number') return renderNumber(value, onChange);
  if (typeof value === 'string') return renderText(value, onChange, value.length > 80);
  if (value === null) return renderText('null', onChange, false);
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === 'string')) return renderStringList(value, path, onChange);
    return renderNested(value, path, onChange);
  }
  return renderNested(value, path, onChange);
}

function renderText(value: string, onChange: () => void, prose: boolean): HTMLElement {
  if (prose) {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.rows = Math.min(6, Math.max(2, Math.ceil(value.length / 90)));
    ta.addEventListener('input', () => onChange());
    return ta;
  }
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.addEventListener('input', () => onChange());
  return input;
}

/** A single-tag text input, autocompleting against the tag vocabulary. */
function renderTagText(value: string, onChange: () => void): HTMLElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.setAttribute('list', 'tag-vocab');
  input.addEventListener('input', () => onChange());
  return input;
}

function renderNumber(value: number, onChange: () => void): HTMLElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = 'any';
  input.value = String(value);
  input.addEventListener('input', () => onChange());
  return input;
}

function renderCheckbox(value: boolean, onChange: () => void): HTMLElement {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = value;
  input.addEventListener('change', () => onChange());
  return input;
}

/**
 * A string array shown as one comma-separated input — the compact form of the
 * string list for table cells. Split on commas on change; empty items dropped.
 */
function renderCsvCell(list: string[], onChange: () => void): HTMLElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = list.join(', ');
  input.addEventListener('change', () => {
    list.length = 0;
    list.push(...input.value.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
    onChange();
  });
  return input;
}

/**
 * Editable list of strings — one input per item, add/remove buttons. `tagKind`
 * turns on tag-vocabulary autocomplete: `'tag'` for a plain tag, `'requires'`
 * for a `requires[]` term (which may carry `!` / `|`, so it is not restricted,
 * only assisted).
 */
function renderStringList(
  list: string[],
  path: string,
  onChange: () => void,
  tagKind?: 'tag' | 'requires',
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'strlist';
  stamp(wrap, path);
  const rebuild = () => {
    const rows = list.map((value, i) => {
      const row = document.createElement('div');
      row.className = 'row';
      stamp(row, `${path}[${i}]`);
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value;
      if (tagKind) input.setAttribute('list', 'tag-vocab');
      input.addEventListener('input', () => { list[i] = input.value; onChange(); });
      const del = document.createElement('button');
      del.textContent = '×';
      del.title = 'remove';
      del.addEventListener('click', () => { list.splice(i, 1); onChange(); rerender(); });
      row.append(input, del);
      return row;
    });
    const add = document.createElement('button');
    add.textContent = '+ add';
    add.addEventListener('click', () => { list.push(''); onChange(); rerender(); });
    wrap.replaceChildren(...rows, add);
    if (tagKind === 'requires') {
      const hint = document.createElement('div');
      hint.className = 'hint-inline';
      hint.textContent = 'one tag per row · "!tag" excludes · "a|b" allows either';
      wrap.append(hint);
    }
  };
  rebuild();
  return wrap;
}

/** Collapsible section for objects and non-string arrays. */
function renderNested(obj: Json, path: string, onChange: () => void): HTMLElement {
  const section = document.createElement('div');
  section.className = 'section';
  stamp(section, path);
  const head = document.createElement('div');
  head.className = 'head';
  head.innerHTML = '<span class="chev">▼</span>';
  const body = document.createElement('div');
  body.className = 'body';
  head.addEventListener('click', () => section.classList.toggle('collapsed'));

  if (Array.isArray(obj)) {
    head.append(span('key', `[${obj.length} items]`));
    obj.forEach((item, i) => {
      const kv = document.createElement('div');
      kv.className = 'kv';
      kv.append(span('key', `[${i}]`));
      const val = document.createElement('div');
      val.className = 'val';
      stamp(val, `${path}[${i}]`);
      val.append(renderValue(item, `${path}[${i}]`, onChange));
      kv.append(val);
      body.append(kv);
    });
  } else {
    const record = obj as JsonRecord;
    const keys = Object.keys(record);
    head.append(span('key', `{${keys.length} keys}`));
    for (const key of keys) {
      const childPath = `${path}.${key}`;
      const kv = document.createElement('div');
      kv.className = 'kv';
      kv.append(span('key', key));
      const val = document.createElement('div');
      val.className = 'val';
      stamp(val, childPath);
      const child = record[key]!;
      if (isRecordArray(child)) {
        val.append(renderTable(child, childPath, onChange, key));
      } else if (Array.isArray(child) && child.every((v) => typeof v === 'string')) {
        const kind = TAG_LIST_KEYS.has(key) ? 'tag' : REQUIRES_KEYS.has(key) ? 'requires' : undefined;
        val.append(renderStringList(child as string[], childPath, onChange, kind));
      } else if (typeof child === 'object' && child !== null) {
        val.append(renderNested(child, childPath, onChange));
      } else if (typeof child === 'string' && SINGLE_TAG_KEYS.has(key)) {
        val.append(renderTagText(child, () => {
          const input = val.querySelector('input');
          if (input) { record[key] = input.value; onChange(); }
        }));
      } else {
        val.append(renderValue(child, childPath, onChange));
      }
      kv.append(val);
      body.append(kv);
    }
  }
  section.append(head, body);
  return section;
}

/**
 * Array of records → table. Columns are the union of keys across records;
 * new rows get every column. Duplicate `id` values are flagged.
 */
function renderTable(
  rows: Record<string, Json>[],
  path: string,
  onChange: () => void,
  label: string,
): HTMLElement {
  const wrap = document.createElement('div');
  stamp(wrap, path);

  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const idCol = columns.includes('id') ? 'id' : null;

  const table = document.createElement('table');
  table.className = 'grid';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const col of columns) headRow.append(th(col));
  headRow.append(th(''));
  thead.append(headRow);

  const tbody = document.createElement('tbody');
  const rebuild = () => {
    tbody.replaceChildren();
    const dupIds = new Set<string>();
    if (idCol) {
      const seen = new Map<string, number>();
      for (const row of rows) {
        const id = String(row[idCol] ?? '');
        seen.set(id, (seen.get(id) ?? 0) + 1);
      }
      for (const [id, n] of seen) if (n > 1 && id) dupIds.add(id);
    }
    rows.forEach((row, rowIndex) => {
      const tr = document.createElement('tr');
      if (idCol && dupIds.has(String(row[idCol] ?? ''))) tr.classList.add('dup');
      for (const col of columns) {
        const td = document.createElement('td');
        stamp(td, `${path}[${rowIndex}].${col}`);
        const value = row[col];
        if (typeof value === 'number') td.className = 'num';
        if (typeof value === 'boolean') td.className = 'bool';
        if (value === undefined || value === null || typeof value === 'object') {
          if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
            // String list in a row cell — comma-separated, not raw JSON.
            td.append(renderCsvCell(value as string[], onChange));
          } else {
            // Rare in a row cell — fall back to a JSON text field.
            const input = document.createElement('input');
            input.type = 'text';
            input.value = value === undefined ? '' : JSON.stringify(value);
            input.addEventListener('change', () => {
              try { row[col] = input.value ? (JSON.parse(input.value) as Json) : ''; onChange(); }
              catch { setStatus('err', `invalid JSON in ${label}[${rowIndex}].${col}`); }
            });
            td.append(input);
          }
        } else if (typeof value === 'string' && SINGLE_TAG_KEYS.has(col)) {
          const input = renderTagText(value, () => {
            const control = td.querySelector('input');
            if (control) { row[col] = control.value; onChange(); }
          });
          td.append(input);
        } else {
          const cell = value as string | number | boolean;
          td.append(
            renderValue(cell, `${path}[${rowIndex}].${col}`, () => {
              // Read the control's live value back into the record.
              const control = td.firstElementChild as HTMLInputElement | null;
              if (!control) return;
              row[col] =
                typeof value === 'number' ? (control.value === '' ? 0 : Number(control.value))
                : typeof value === 'boolean' ? control.checked
                : control.value;
              onChange();
            }),
          );
        }
        tr.append(td);
      }
      const actions = document.createElement('td');
      actions.className = 'actions';
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '×';
      del.title = 'delete row';
      del.addEventListener('click', () => { rows.splice(rowIndex, 1); onChange(); rerender(); });
      actions.append(del);
      tr.append(actions);
      tbody.append(tr);
    });
  };
  rebuild();

  const add = document.createElement('button');
  add.textContent = `+ add ${label}`;
  add.addEventListener('click', () => {
    const blank: Record<string, Json> = {};
    for (const col of columns) {
      const sample = rows.find((row) => row[col] !== undefined)?.[col];
      blank[col] = typeof sample === 'number' ? 0 : typeof sample === 'boolean' ? false : Array.isArray(sample) ? [] : '';
    }
    rows.push(blank);
    onChange();
    rerender();
  });

  table.append(thead, tbody);
  wrap.append(add, table);
  return wrap;
}

function span(cls: string, text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}

function th(text: string): HTMLElement {
  const el = document.createElement('th');
  el.textContent = text;
  return el;
}

// ---------------------------------------------------------------------------
// Validation — the engine's own checker, run live over the unsaved files
// ---------------------------------------------------------------------------

let validateTimer: number | undefined;

/** Debounced: rebuild the vocabulary, re-run the validator, repaint the issues. */
function scheduleValidate(): void {
  window.clearTimeout(validateTimer);
  validateTimer = window.setTimeout(() => void runValidate(), 200);
}

async function runValidate(): Promise<void> {
  rebuildVocabulary();
  const files = new Map<string, Json>();
  for (const [path, file] of state) files.set(path, file.current);
  try {
    report = await validateFiles(files);
  } catch (err) {
    // A validator crash must never take the editor down — show it and carry on.
    setStatus('err', `validation failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  paintIssues();
  renderSidebar();
}

/** Attach a badge to the most specific control each issue names. */
function paintIssues(): void {
  const editor = $('#editor');
  editor.querySelectorAll('.issue-badge').forEach((el) => el.remove());
  editor.querySelectorAll('[data-path]').forEach((el) => {
    el.classList.remove('has-error', 'has-warning');
  });
  if (!report || !activePath) return;

  const root = state.get(activePath)?.entry.path;
  if (!root) return;
  const mine = [...report.errors, ...report.warnings].filter((i) => issueBelongsTo(i, root));

  // Longest data-path first, so a badge lands on the innermost matching field.
  const anchors = [...editor.querySelectorAll<HTMLElement>('[data-path]')].sort(
    (a, b) => (b.dataset['path']?.length ?? 0) - (a.dataset['path']?.length ?? 0),
  );
  for (const issue of mine) {
    const host = anchors.find((el) => pathIsUnder(issue.path, el.dataset['path'] ?? '\0'));
    if (host) attachBadge(host, issue);
  }
}

function attachBadge(host: HTMLElement, issue: ValidationIssue): void {
  host.classList.add(issue.level === 'error' ? 'has-error' : 'has-warning');
  const badge = document.createElement('span');
  badge.className = `issue-badge ${issue.level}`;
  badge.textContent = issue.level === 'error' ? '✕' : '!';
  badge.title = issue.message;
  // Sit the badge on the field's row where possible, not deep inside a table.
  const anchor = host.closest('td, .row, .val, .section') ?? host;
  anchor.prepend(badge);
}

// ---------------------------------------------------------------------------
// Issues sidebar
// ---------------------------------------------------------------------------

function renderSidebar(): void {
  const aside = $('#issues');
  aside.replaceChildren();

  const head = document.createElement('div');
  head.className = 'issues-head';
  if (!report) {
    head.textContent = 'validating…';
    aside.append(head);
    return;
  }
  const errs = report.errors.length;
  const warns = report.warnings.length;
  head.append(span('title', 'Validation'));
  head.append(pill('errs', `${errs} error${errs === 1 ? '' : 's'}`, errs > 0));
  head.append(pill('warns', `${warns} warning${warns === 1 ? '' : 's'}`, warns > 0));
  aside.append(head);

  if (errs === 0 && warns === 0) {
    const ok = document.createElement('div');
    ok.className = 'issues-clean';
    ok.textContent = '✓ everything cross-references';
    aside.append(ok);
    return;
  }

  const list = document.createElement('div');
  list.className = 'issues-list';
  for (const issue of [...report.errors, ...report.warnings]) {
    list.append(issueRow(issue));
  }
  aside.append(list);
}

function issueRow(issue: ValidationIssue): HTMLElement {
  const row = document.createElement('div');
  row.className = `issue ${issue.level}`;
  const path = document.createElement('div');
  path.className = 'issue-path';
  path.textContent = issue.path;
  const msg = document.createElement('div');
  msg.className = 'issue-msg';
  msg.textContent = issue.message;
  row.append(path, msg);
  const owner = fileOwning(issue);
  if (owner) {
    row.classList.add('clickable');
    row.addEventListener('click', () => void jumpToIssue(owner, issue));
  }
  return row;
}

/** The editor file whose issue-root this issue path falls under. */
function fileOwning(issue: ValidationIssue): FileEntry | undefined {
  return FILES.find((entry) => issueBelongsTo(issue, entry.path));
}

async function jumpToIssue(entry: FileEntry, issue: ValidationIssue): Promise<void> {
  if (activePath !== entry.path) {
    await openFile(entry.path);
  }
  const editor = $('#editor');
  const anchors = [...editor.querySelectorAll<HTMLElement>('[data-path]')].sort(
    (a, b) => (b.dataset['path']?.length ?? 0) - (a.dataset['path']?.length ?? 0),
  );
  const host = anchors.find((el) => pathIsUnder(issue.path, el.dataset['path'] ?? '\0'));
  const target = host?.closest('td, .row, .val, .section') ?? host;
  if (target) {
    // Open any collapsed ancestor sections so the field is actually visible.
    let node: HTMLElement | null = target as HTMLElement;
    while (node) {
      if (node.classList.contains('section')) node.classList.remove('collapsed');
      node = node.parentElement;
    }
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.add('flash');
    window.setTimeout(() => target.classList.remove('flash'), 1200);
  }
}

function pill(cls: string, text: string, live: boolean): HTMLElement {
  const el = document.createElement('span');
  el.className = `pill ${cls}` + (live ? ' live' : '');
  el.textContent = text;
  return el;
}

// ---------------------------------------------------------------------------
// Tabs and file view
// ---------------------------------------------------------------------------

function renderTabs(): void {
  const tabs = $('#tabs');
  tabs.replaceChildren();
  for (const category of CATEGORIES) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (category === activeCategory ? ' active' : '');
    tab.textContent = category;
    if (categoryHasError(category)) tab.classList.add('has-error');
    tab.addEventListener('click', () => {
      activeCategory = category;
      const first = FILES.find((f) => f.category === category);
      if (first) void openFile(first.path);
    });
    tabs.append(tab);
  }

  const subtabs = $('#subtabs');
  subtabs.replaceChildren();
  const inCategory = FILES.filter((f) => f.category === activeCategory);
  if (inCategory.length > 1) {
    for (const file of inCategory) {
      const tab = document.createElement('div');
      tab.className = 'tab sub' + (file.path === activePath ? ' active' : '');
      if (isDirty(file.path)) tab.classList.add('dirty');
      if (fileHasError(file.path)) tab.classList.add('has-error');
      tab.textContent = file.label;
      tab.addEventListener('click', () => void openFile(file.path));
      subtabs.append(tab);
    }
  }
}

function fileHasError(path: string): boolean {
  if (!report) return false;
  const entry = FILES.find((f) => f.path === path);
  return entry ? report.errors.some((i) => issueBelongsTo(i, entry.path)) : false;
}

function categoryHasError(category: string): boolean {
  return FILES.some((f) => f.category === category && fileHasError(f.path));
}

async function openFile(path: string): Promise<void> {
  const entry = FILES.find((f) => f.path === path);
  if (!entry) return;
  if (!state.has(path)) {
    try {
      await loadFile(entry);
    } catch (err) {
      setStatus('err', `load failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }
  activePath = path;
  activeCategory = entry.category;
  renderTabs();
  renderFile();
  updateButtons();
  paintIssues();
  setStatus('ok', path);
}

function renderFile(): void {
  const editor = $('#editor');
  editor.replaceChildren();
  if (!activePath) return;
  const file = state.get(activePath);
  if (!file) return;

  const rootPath = issueRootFor(file.entry);
  const markDirty = () => {
    renderTabs();
    updateButtons();
    scheduleValidate();
  };
  const root = file.current;
  if (isRecordArray(root)) {
    editor.append(renderTable(root, rootPath, markDirty, file.entry.label));
  } else if (typeof root === 'object' && root !== null) {
    editor.append(renderNested(root, rootPath, markDirty));
  } else {
    editor.append(renderValue(root, rootPath, markDirty));
  }
}

/** The prefix the validator roots this file's issue paths at. */
function issueRootFor(entry: FileEntry): string {
  return entry.path.startsWith(`${BASE}/`) ? entry.path.slice(`${BASE}/`.length) : entry.path;
}

/** Full re-render after structural changes (add/delete row, list item). */
function rerender(): void {
  renderFile();
  updateButtons();
  paintIssues();
  scheduleValidate();
}

function updateButtons(): void {
  const dirty = activePath !== null && isDirty(activePath);
  ($('#save') as HTMLButtonElement).disabled = !dirty;
  ($('#revert') as HTMLButtonElement).disabled = !dirty;
  ($('#reload') as HTMLButtonElement).disabled = activePath === null;
}

function setStatus(kind: 'ok' | 'warn' | 'err', message: string): void {
  const el = $('#status');
  el.textContent = message;
  el.className = kind;
}

// ---------------------------------------------------------------------------
// Recovery — revert, and a diff review before every write
// ---------------------------------------------------------------------------

function revertFile(path: string): void {
  const file = state.get(path);
  if (!file || !isDirty(path)) return;
  file.current = structuredClone(file.original);
  renderFile();
  updateButtons();
  renderTabs();
  setStatus('warn', `reverted ${path} — unsaved edits discarded`);
  scheduleValidate();
}

/** One line of a diff between the on-disk copy and the edited copy. */
interface DiffLine {
  kind: ' ' | '+' | '-';
  text: string;
}

/** A minimal line diff over the pretty-printed JSON — enough to review a write. */
function diffLines(before: string[], after: string[]): DiffLine[] {
  const n = before.length;
  const m = after.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = before[i] === after[j]
        ? lcs[i + 1]![j + 1]! + 1
        : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ kind: ' ', text: before[i]! });
      i++; j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: '-', text: before[i]! });
      i++;
    } else {
      out.push({ kind: '+', text: after[j]! });
      j++;
    }
  }
  while (i < n) out.push({ kind: '-', text: before[i++]! });
  while (j < m) out.push({ kind: '+', text: after[j++]! });
  return out;
}

/** Show the diff for a file and resolve true if the user confirms the write. */
function reviewChanges(path: string): Promise<boolean> {
  const file = state.get(path);
  return new Promise((resolve) => {
    if (!file) return resolve(false);
    const before = JSON.stringify(file.original, null, 2).split('\n');
    const after = JSON.stringify(file.current, null, 2).split('\n');
    const lines = diffLines(before, after).filter((l, idx, all) => {
      // Trim long runs of unchanged context to keep the review readable.
      if (l.kind !== ' ') return true;
      const near = (k: number) => all[k] && all[k]!.kind !== ' ';
      return near(idx - 1) || near(idx - 2) || near(idx + 1) || near(idx + 2);
    });

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'modal';
    const title = document.createElement('div');
    title.className = 'modal-title';
    const added = lines.filter((l) => l.kind === '+').length;
    const removed = lines.filter((l) => l.kind === '-').length;
    title.textContent = `Write ${path}?  (+${added} / −${removed} lines)`;
    const pre = document.createElement('pre');
    pre.className = 'diff';
    let lastContext = false;
    for (const line of lines) {
      if (line.kind === ' ' && !lastContext) {
        // A break marker between separated change regions.
      }
      lastContext = line.kind === ' ';
      const div = document.createElement('div');
      div.className = `dl ${line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : 'ctx'}`;
      div.textContent = `${line.kind} ${line.text}`;
      pre.append(div);
    }
    if (added === 0 && removed === 0) {
      pre.append(Object.assign(document.createElement('div'), { className: 'dl ctx', textContent: '(no changes)' }));
    }
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    const confirm = document.createElement('button');
    confirm.textContent = 'Write to disk';
    confirm.className = 'primary';
    const close = (ok: boolean) => { overlay.remove(); resolve(ok); };
    cancel.addEventListener('click', () => close(false));
    confirm.addEventListener('click', () => close(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    actions.append(cancel, confirm);
    modal.append(title, pre, actions);
    overlay.append(modal);
    document.body.append(overlay);
  });
}

async function saveWithReview(path: string): Promise<void> {
  if (!isDirty(path)) return;
  const ok = await reviewChanges(path);
  if (ok) await saveFile(path);
}

// ---------------------------------------------------------------------------
// Wire-up
// ---------------------------------------------------------------------------

$('#pick-dir').addEventListener('click', () => void pickDirectory());
$('#save').addEventListener('click', () => { if (activePath) void saveWithReview(activePath); });
$('#revert').addEventListener('click', () => { if (activePath) revertFile(activePath); });
$('#reload').addEventListener('click', () => {
  if (!activePath) return;
  const file = state.get(activePath);
  if (!file) return;
  state.delete(activePath);
  void openFile(activePath).then(() => scheduleValidate());
  setStatus('warn', `reloaded ${activePath} — local edits discarded`);
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 's') {
    event.preventDefault();
    if (activePath && isDirty(activePath)) void saveWithReview(activePath);
  }
});

/**
 * Boot: load every file up front (validation is whole-campaign — it cannot
 * check cross-references it has not loaded), then open the first tab and run the
 * first validation pass.
 */
async function boot(): Promise<void> {
  setStatus('ok', 'loading all tables…');
  const results = await Promise.allSettled(FILES.map(loadFile));
  const failed = results
    .map((r, i) => (r.status === 'rejected' ? FILES[i]!.label : null))
    .filter((x): x is string => x !== null);
  if (failed.length) setStatus('warn', `some files failed to load: ${failed.join(', ')}`);
  await openFile(FILES[0]!.path);
  await runValidate();
}

void boot();
