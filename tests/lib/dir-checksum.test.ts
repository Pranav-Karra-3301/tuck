/**
 * Directory checksum unit tests.
 *
 * getFileChecksum on a directory previously hashed only file CONTENTS (joined
 * in path order), ignoring the file NAMES/structure. So renaming a file inside
 * a tracked directory (e.g. ~/.config/nvim) produced an identical checksum and
 * the change was silently never synced. The digest must fold in each entry's
 * relative path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { getFileChecksum } from '../../src/lib/files.js';

const DIR = '/test-home/cfgdir';

describe('getFileChecksum (directory)', () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(DIR, { recursive: true });
  });

  it('changes when a file is renamed even if content is identical', async () => {
    vol.writeFileSync(`${DIR}/a.txt`, 'same-content');
    const before = await getFileChecksum(DIR);

    vol.unlinkSync(`${DIR}/a.txt`);
    vol.writeFileSync(`${DIR}/b.txt`, 'same-content');
    const after = await getFileChecksum(DIR);

    expect(after).not.toBe(before);
  });

  it('is stable for identical structure and content', async () => {
    vol.writeFileSync(`${DIR}/a.txt`, 'AAA');
    vol.mkdirSync(`${DIR}/sub`, { recursive: true });
    vol.writeFileSync(`${DIR}/sub/b.txt`, 'BBB');
    const c1 = await getFileChecksum(DIR);
    const c2 = await getFileChecksum(DIR);
    expect(c2).toBe(c1);
  });

  it('changes when a new file is added', async () => {
    vol.writeFileSync(`${DIR}/a.txt`, 'AAA');
    const before = await getFileChecksum(DIR);
    vol.writeFileSync(`${DIR}/c.txt`, 'CCC');
    const after = await getFileChecksum(DIR);
    expect(after).not.toBe(before);
  });
});
