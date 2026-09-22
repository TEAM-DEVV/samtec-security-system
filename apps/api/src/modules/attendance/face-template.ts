/**
 * Locking a face template away (docs/plan/13-biometrics-design.md section 1).
 *
 * A template is 1,024 numbers, and those numbers can be turned back into a
 * rough face, so they are personal data. They are stored with AES-256-GCM,
 * under a key derived from `AUTH_SECRET`, and **bound to the row they belong
 * to**: the company, the worker, the credential row and the key version go in
 * as "associated data". Copying a sealed template onto another person's row
 * therefore fails to open instead of quietly working.
 *
 * Stored bytes: `[1 byte format][12 bytes IV][16 bytes tag][the numbers]`,
 * where the numbers are 8 bytes each, exactly as they arrived.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { deriveKey } from '../identity/secret-box.js';
import { FACE_THRESHOLDS } from './face-thresholds.js';

const FORMAT = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const NUMBER_BYTES = 8;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

/** The key version written on every new template. Rotating the key is a Phase 7 task. */
export const FACE_KEY_VERSION = 1;

/** The row a template belongs to. Change any part of it and the template will not open. */
export interface TemplateRow {
  companyId: string;
  employeeId: string;
  credentialId: string;
  keyVersion: number;
}

/** The face key, from the one master secret the project keeps. */
export function faceTemplateKey(authSecret: string): Buffer {
  return deriveKey(authSecret, 'face-template');
}

/** Encrypts the numbers for one row. Throws only on a programming mistake (a wrong-sized list). */
export function sealTemplate(embedding: readonly number[], row: TemplateRow, key: Buffer): Buffer {
  // Every place is checked by index, so a list with holes in it (which
  // `every` would skip over) is refused like any other wrong list.
  let sound = embedding.length === FACE_THRESHOLDS.embeddingLength;
  for (let index = 0; sound && index < embedding.length; index += 1) {
    sound = Number.isFinite(embedding[index]);
  }
  if (!sound) {
    // The message never carries the numbers themselves.
    throw new RangeError('a face template is exactly 1,024 real numbers');
  }
  const numbers = Buffer.alloc(embedding.length * NUMBER_BYTES);
  embedding.forEach((value, index) => {
    numbers.writeDoubleLE(value, index * NUMBER_BYTES);
  });

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(binding(row));
  const sealed = Buffer.concat([cipher.update(numbers), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT]), iv, cipher.getAuthTag(), sealed]);
}

/**
 * Decrypts the numbers of one row. Returns null when the bytes are damaged, or
 * belong to another row, or were sealed with another key: never a wrong answer.
 */
export function openTemplate(sealed: Uint8Array, row: TemplateRow, key: Buffer): number[] | null {
  const bytes = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  const expected = HEADER_BYTES + FACE_THRESHOLDS.embeddingLength * NUMBER_BYTES;
  if (bytes.length !== expected || bytes[0] !== FORMAT) {
    return null;
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 1 + IV_BYTES));
    decipher.setAAD(binding(row));
    decipher.setAuthTag(bytes.subarray(1 + IV_BYTES, HEADER_BYTES));
    const numbers = Buffer.concat([
      decipher.update(bytes.subarray(HEADER_BYTES)),
      decipher.final(),
    ]);
    const embedding: number[] = [];
    for (let offset = 0; offset < numbers.length; offset += NUMBER_BYTES) {
      embedding.push(numbers.readDoubleLE(offset));
    }
    return embedding;
  } catch {
    return null;
  }
}

function binding(row: TemplateRow): Buffer {
  return Buffer.from(
    `${row.companyId}|${row.employeeId}|${row.credentialId}|${row.keyVersion}`,
    'utf8',
  );
}
