import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  normaliseSettings,
  saveSettings,
  type NarratorSettings,
} from '../src/narrator/settings';

/** A minimal in-memory Storage stand-in for the two methods settings uses. */
function memoryStore(seed?: string): Storage & { last?: string } {
  let value: string | null = seed ?? null;
  return {
    getItem: () => value,
    setItem(_key: string, next: string) {
      value = next;
      (this as { last?: string }).last = next;
    },
  } as unknown as Storage & { last?: string };
}

describe('normalise-on-read', () => {
  it('fills every gap with a default', () => {
    expect(normaliseSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(normaliseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normaliseSettings('nonsense')).toEqual(DEFAULT_SETTINGS);
  });

  it('trims the key but never otherwise alters it', () => {
    expect(normaliseSettings({ apiKey: '  sk-or-123  ' }).apiKey).toBe('sk-or-123');
  });

  it('clamps temperature into range and repairs a bad number', () => {
    expect(normaliseSettings({ temperature: 9 }).temperature).toBe(2);
    expect(normaliseSettings({ temperature: -1 }).temperature).toBe(0);
    expect(normaliseSettings({ temperature: 'hot' }).temperature).toBe(DEFAULT_SETTINGS.temperature);
  });

  it('falls back to a default model when a slot is blank', () => {
    const settings = normaliseSettings({ narratorModel: '   ', translatorModel: 'x/y' });
    expect(settings.narratorModel).toBe(DEFAULT_SETTINGS.narratorModel);
    expect(settings.translatorModel).toBe('x/y');
  });
});

describe('load and save', () => {
  it('round-trips through a store', () => {
    const store = memoryStore();
    const settings: NarratorSettings = {
      apiKey: 'sk-or-abc',
      narratorModel: 'a/b',
      translatorModel: 'c/d',
      temperature: 1.2,
      maxTokens: 800,
    };
    saveSettings(settings, store);
    expect(loadSettings(store)).toEqual(settings);
  });

  it('reads defaults when there is no store and never throws', () => {
    expect(loadSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(memoryStore('{ broken json'))).toEqual(DEFAULT_SETTINGS);
  });
});
