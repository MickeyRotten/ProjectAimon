/**
 * Saving and loading.
 *
 * Two slot kinds, per the data model: one autosave, written every turn at the
 * end of the world half — the loop already has exactly one place to write it —
 * and unlimited named snapshots the player asks for.
 *
 * The payload is the whole world. That is the point: generated areas live in
 * the save, so retuning a table never reaches a game already in progress, and
 * loading never regenerates anything.
 *
 * Storage is IndexedDB through Dexie in the browser. The interface is small
 * and the memory implementation is real, so the turn loop can be tested
 * without a browser and an export bundle is the same shape as a save.
 */

import type { ResolvedCampaign } from '../campaign/types';
import { Game, type GameSnapshot } from './game';

export type SaveKind = 'auto' | 'snapshot';

export interface SaveRecord {
  /** `auto:<campaignId>` for the autosave; `snap:<label>` for the rest. */
  id: string;
  campaignId: string;
  campaignVersion: string;
  kind: SaveKind;
  label: string;
  characterName: string;
  turn: number;
  areaId: string;
  savedAt: number;
  payload: GameSnapshot;
}

export interface SaveStore {
  put(record: SaveRecord): Promise<void>;
  get(id: string): Promise<SaveRecord | undefined>;
  list(): Promise<SaveRecord[]>;
  delete(id: string): Promise<void>;
}

export const AUTOSAVE_ID = (campaignId: string): string => `auto:${campaignId}`;
export const snapshotId = (label: string): string => `snap:${label.toLowerCase().trim()}`;

/** A save record for the game as it stands. */
export function recordOf(game: Game, kind: SaveKind, label: string): SaveRecord {
  const payload = game.snapshot();
  return {
    id: kind === 'auto' ? AUTOSAVE_ID(game.campaign.id) : snapshotId(label),
    campaignId: game.campaign.id,
    campaignVersion: game.campaign.manifest.version,
    kind,
    label,
    characterName: game.player.name,
    turn: game.turn,
    areaId: game.room.areaId,
    savedAt: Date.now(),
    payload,
  };
}

export class SaveLoadError extends Error {}

/**
 * Open a save. A save stamped against an older campaign version still loads —
 * the world is in the payload, not in the tables — but a save belonging to a
 * campaign that is not installed refuses rather than half-loading against base.
 */
export function openSave(campaign: ResolvedCampaign, record: SaveRecord): {
  game: Game;
  notes: string[];
} {
  if (record.campaignId !== campaign.id) {
    throw new SaveLoadError(
      `this save needs campaign "${record.campaignId}", and "${campaign.id}" is loaded`,
    );
  }
  const notes: string[] = [];
  if (record.campaignVersion !== campaign.manifest.version) {
    notes.push(
      `saved against ${record.campaignId} v${record.campaignVersion}, now v${campaign.manifest.version} — the world in the save is unchanged`,
    );
  }
  return { game: Game.restore(campaign, record.payload), notes };
}

/** In-memory storage. Real, ordered, and what the tests run against. */
export class MemorySaveStore implements SaveStore {
  private readonly rows = new Map<string, SaveRecord>();

  async put(record: SaveRecord): Promise<void> {
    this.rows.set(record.id, structuredClone(record));
  }

  async get(id: string): Promise<SaveRecord | undefined> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async list(): Promise<SaveRecord[]> {
    return [...this.rows.values()]
      .map((row) => structuredClone(row))
      .sort((a, b) => b.savedAt - a.savedAt);
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }
}

/**
 * IndexedDB, through Dexie. Imported lazily so that everything above this line
 * runs anywhere — a test, a script, a node tool — and only the browser pays
 * for the database.
 */
export function browserSaveStore(databaseName = 'aimon'): SaveStore {
  type DexieLike = {
    table(name: string): {
      put(record: SaveRecord): Promise<unknown>;
      get(id: string): Promise<SaveRecord | undefined>;
      toArray(): Promise<SaveRecord[]>;
      delete(id: string): Promise<unknown>;
    };
  };

  let opening: Promise<DexieLike> | undefined;
  const database = async (): Promise<DexieLike> => {
    if (!opening) {
      opening = import('dexie').then(({ default: Dexie }) => {
        const db = new Dexie(databaseName);
        db.version(1).stores({ saves: 'id, campaignId, kind, savedAt' });
        return db as unknown as DexieLike;
      });
    }
    return opening;
  };

  return {
    async put(record) {
      await (await database()).table('saves').put(record);
    },
    async get(id) {
      return (await database()).table('saves').get(id);
    },
    async list() {
      const rows = await (await database()).table('saves').toArray();
      return rows.sort((a, b) => b.savedAt - a.savedAt);
    },
    async delete(id) {
      await (await database()).table('saves').delete(id);
    },
  };
}

/**
 * Is this input a save or a load? The prompt asks before the turn loop does,
 * because storage is asynchronous and the turn loop is not.
 */
export function parseSaveCommand(
  raw: string,
  verbs: { verbs: { id: string; words: string[] }[] },
): { verb: 'save' | 'load'; label: string } | undefined {
  const words = raw.toLowerCase().trim().split(/\s+/).filter((word) => word.length > 0);
  const head = words[0];
  if (!head) return undefined;
  const verb = verbs.verbs.find((entry) => entry.words.includes(head));
  if (verb?.id !== 'save' && verb?.id !== 'load') return undefined;
  return { verb: verb.id, label: words.slice(1).join(' ') };
}

/** One JSON file: the backup, and the PC-to-phone transfer. */
export const exportSave = (record: SaveRecord): string => JSON.stringify(record);

export function importSave(text: string): SaveRecord {
  const parsed = JSON.parse(text) as SaveRecord;
  if (!parsed || typeof parsed !== 'object' || !parsed.payload) {
    throw new SaveLoadError('that file is not an Aimon save');
  }
  return parsed;
}
