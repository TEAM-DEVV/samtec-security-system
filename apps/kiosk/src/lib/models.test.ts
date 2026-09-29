// @vitest-environment node
/// <reference types="node" />
// This one test runs in Node, not the pretend browser: it reads committed
// files off the disk, which no kiosk screen ever does.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The committed model files against the hashes pinned in their README.
 *
 * The promise "anyone can re-download and compare" is only worth making if it
 * stays true, and it once quietly stopped being true: a formatter pass
 * re-indented the model JSON files after their hashes were taken. The models
 * are now excluded from every formatter and from line-ending conversion, and
 * this test fails the build the moment any tool touches a byte of them again.
 */
const MODELS_FOLDER = fileURLToPath(new URL('../../public/models', import.meta.url));

describe('the committed face models', () => {
  const readme = readFileSync(join(MODELS_FOLDER, 'README.md'), 'utf8');
  const files = readdirSync(MODELS_FOLDER)
    .filter((name: string) => name.endsWith('.json') || name.endsWith('.bin'))
    .sort();

  it('are exactly the ten files Human is configured to load', () => {
    expect(files).toEqual([
      'antispoof.bin',
      'antispoof.json',
      'blazeface.bin',
      'blazeface.json',
      'facemesh.bin',
      'facemesh.json',
      'faceres.bin',
      'faceres.json',
      'liveness.bin',
      'liveness.json',
    ]);
  });

  for (const file of files) {
    it(`still has the pinned bytes: ${file}`, () => {
      const hash = createHash('sha256')
        .update(readFileSync(join(MODELS_FOLDER, file)))
        .digest('hex');
      expect(readme, `${file} hashes to ${hash}, which the README does not pin`).toContain(hash);
    });
  }
});
