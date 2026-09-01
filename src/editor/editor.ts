/**
 * Aimon data editor — a dev-only tool for editing the JSON tables.
 *
 * Served by `npm run dev` at /editor.html; never part of the production build.
 * Loads files with fetch() (the dev server serves the repo root), renders them
 * generically — arrays of records as table rows, maps as field lists, string
 * arrays as editable lists — and writes edits back in place via the File
 * System Access API (PC Chromium only; read-only elsewhere).
 *
 * Deliberately dumb: no schema awareness, no undo, no diffing. The JSON is the
 * schema.
 */

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

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface JsonRecord {
  [key: string]: Json;
}

/** File System Access API — not yet in the TS DOM lib. */
interface Window {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
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

/** Directory handle for in-place writes; null until the user picks one. */
let dirHandle: FileSystemDirectoryHandle | null = null;

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
  } catch (err) {
    setStatus('err', `save failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Renderer — generic JSON → controls
// ---------------------------------------------------------------------------

/** Long text fields get a textarea instead of a one-line input. */
const PROSE_KEYS = new Set(['desc', 'baseDesc', 'note', '_note', 'template', 'personaTemplate', 'text']);

function isRecordArray(value: Json): value is JsonRecord[] {
  return Array.isArray(value) && value.length > 0 && value.every(isJsonRecord);
}

function renderValue(value: Json, onChange: () => void): HTMLElement {
  if (typeof value === 'boolean') return renderCheckbox(value, onChange);
  if (typeof value === 'number') return renderNumber(value, onChange);
  if (typeof value === 'string') return renderText(value, onChange, PROSE_KEYS.has('') || value.length > 80);
  if (value === null) return renderText('null', onChange, false);
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === 'string')) return renderStringList(value, onChange);
    return renderNested(value, onChange);
  }
  return renderNested(value, onChange);
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

/** Editable list of strings — one input per item, add/remove buttons. */
function renderStringList(list: string[], onChange: () => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'strlist';
  const rebuild = () => {
    wrap.replaceChildren(...list.map((value, i) => {
      const row = document.createElement('div');
      row.className = 'row';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value;
      input.addEventListener('input', () => { list[i] = input.value; onChange(); });
      const del = document.createElement('button');
      del.textContent = '×';
      del.title = 'remove';
      del.addEventListener('click', () => { list.splice(i, 1); onChange(); rerender(); });
      row.append(input, del);
      return row;
    }));
  };
  const add = document.createElement('button');
  add.textContent = '+ add';
  add.addEventListener('click', () => { list.push(''); onChange(); rerender(); });
  wrap.append(...(list.length ? [] : [document.createTextNode('')]));
  rebuild();
  wrap.append(add);
  return wrap;
}

/** Collapsible section for objects and non-string arrays. */
function renderNested(obj: Json, onChange: () => void): HTMLElement {
  const section = document.createElement('div');
  section.className = 'section';
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
      val.append(renderValue(item, onChange));
      kv.append(val);
      body.append(kv);
    });
  } else {
    const record = obj as JsonRecord;
    const keys = Object.keys(record);
    head.append(span('key', `{${keys.length} keys}`));
    for (const key of keys) {
      const kv = document.createElement('div');
      kv.className = 'kv';
      kv.append(span('key', key));
      const val = document.createElement('div');
      val.className = 'val';
      const child = record[key]!;
      if (isRecordArray(child)) {
        val.append(renderTable(child, onChange, key));
      } else if (Array.isArray(child) && child.every((v) => typeof v === 'string')) {
        val.append(renderStringList(child as string[], onChange));
      } else if (typeof child === 'object' && child !== null) {
        val.append(renderNested(child, onChange));
      } else {
        val.append(renderValue(child, onChange));
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
function renderTable(rows: Record<string, Json>[], onChange: () => void, label: string): HTMLElement {
  const wrap = document.createElement('div');

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
        } else {
          const cell = value as string | number | boolean;
          td.append(
            renderValue(cell, () => {
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
// Tabs and file view
// ---------------------------------------------------------------------------

function renderTabs(): void {
  const tabs = $('#tabs');
  tabs.replaceChildren();
  for (const category of CATEGORIES) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (category === activeCategory ? ' active' : '');
    tab.textContent = category;
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
      tab.textContent = file.label;
      tab.addEventListener('click', () => void openFile(file.path));
      subtabs.append(tab);
    }
  }
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
  setStatus('ok', path);
}

function renderFile(): void {
  const editor = $('#editor');
  editor.replaceChildren();
  if (!activePath) return;
  const file = state.get(activePath);
  if (!file) return;

  const markDirty = () => {
    renderTabs();
    updateButtons();
  };
  const root = file.current;
  if (isRecordArray(root)) {
    editor.append(renderTable(root, markDirty, file.entry.label));
  } else if (typeof root === 'object' && root !== null) {
    editor.append(renderNested(root, markDirty));
  } else {
    editor.append(renderValue(root, markDirty));
  }
}

/** Full re-render after structural changes (add/delete row, list item). */
function rerender(): void {
  renderFile();
  updateButtons();
}

function updateButtons(): void {
  const dirty = activePath !== null && isDirty(activePath);
  ($('#save') as HTMLButtonElement).disabled = !dirty;
  ($('#reload') as HTMLButtonElement).disabled = activePath === null;
}

function setStatus(kind: 'ok' | 'warn' | 'err', message: string): void {
  const el = $('#status');
  el.textContent = message;
  el.className = kind;
}

// ---------------------------------------------------------------------------
// Wire-up
// ---------------------------------------------------------------------------

$('#pick-dir').addEventListener('click', () => void pickDirectory());
$('#save').addEventListener('click', () => { if (activePath) void saveFile(activePath); });
$('#reload').addEventListener('click', () => {
  if (!activePath) return;
  const file = state.get(activePath);
  if (!file) return;
  state.delete(activePath);
  void openFile(activePath);
  setStatus('warn', `reloaded ${activePath} — local edits discarded`);
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 's') {
    event.preventDefault();
    if (activePath && isDirty(activePath)) void saveFile(activePath);
  }
});

void openFile(FILES[0]!.path);
