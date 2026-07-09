/**
 * Pure capture logic: given two snapshots of the same domain (before and after
 * the user changed a setting in the GUI), determine what changed and turn each
 * change into a replayable `defaults` command.
 *
 * Keeping this free of any I/O makes the heart of capture mode unit-testable
 * without spawning `defaults`: the backend feeds it parsed snapshots, and it
 * returns typed CapturedChange records.
 */
import type { PlistValue } from './plist.js';
import { stableStringify } from './plist.js';
import type { DomainSnapshot, CapturedChange } from './types.js';
import type { SettingType } from '../../schemas/osSettings.schema.js';

/**
 * Infer a supported scalar `defaults` type and its string form from a parsed
 * plist value. Returns null for containers (dict/array) and opaque data, which
 * v1 does not auto-replay.
 */
export const inferWriteFromValue = (
  value: PlistValue
): { type: SettingType; value: string } | null => {
  switch (value.kind) {
    case 'boolean':
      return { type: 'boolean', value: value.value ? 'true' : 'false' };
    case 'integer':
      return { type: 'integer', value: String(value.value) };
    case 'real':
      return { type: 'float', value: String(value.value) };
    case 'string':
      return { type: 'string', value: value.value };
    case 'date':
      return { type: 'date', value: value.value };
    default:
      // data / dict / array — recorded as a change but not auto-applyable.
      return null;
  }
};

/**
 * Diff two snapshots of the same domain. A key that appears/changes yields a
 * `write` change; a key that disappears yields a `delete` change. Order is
 * deterministic (sorted by key) so capture output and tests are stable.
 */
export const diffSnapshots = (before: DomainSnapshot, after: DomainSnapshot): CapturedChange[] => {
  if (before.domain !== after.domain) {
    throw new Error(`diffSnapshots: domain mismatch ("${before.domain}" vs "${after.domain}")`);
  }
  const domain = after.domain;
  const changes: CapturedChange[] = [];
  const keys = new Set<string>([...before.entries.keys(), ...after.entries.keys()]);

  for (const key of [...keys].sort()) {
    const prev = before.entries.get(key);
    const next = after.entries.get(key);

    if (next === undefined) {
      // Key removed → deletion.
      changes.push({ domain, key, action: 'delete' });
      continue;
    }
    if (prev !== undefined && stableStringify(prev) === stableStringify(next)) {
      continue; // unchanged
    }

    // Added or modified.
    const inferred = inferWriteFromValue(next);
    if (inferred) {
      changes.push({ domain, key, action: 'write', type: inferred.type, value: inferred.value });
    } else {
      changes.push({ domain, key, action: 'write', unsupported: true });
    }
  }

  return changes;
};

/** Diff many domain snapshot pairs and flatten the results. */
export const diffDomains = (
  before: DomainSnapshot[],
  after: DomainSnapshot[]
): CapturedChange[] => {
  const beforeByDomain = new Map(before.map((s) => [s.domain, s]));
  const changes: CapturedChange[] = [];
  for (const afterSnap of after) {
    const beforeSnap =
      beforeByDomain.get(afterSnap.domain) ??
      ({ domain: afterSnap.domain, entries: new Map() } satisfies DomainSnapshot);
    changes.push(...diffSnapshots(beforeSnap, afterSnap));
  }
  return changes;
};

/** A stable id for a captured setting, unique per (os, domain, key). */
export const settingId = (os: string, domain: string, key: string): string => {
  const slug = (s: string): string =>
    s
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  return `${os}__${slug(domain)}__${slug(key)}`;
};
