/**
 * Gnito — backup encryption round-trip test.
 * Uses the real crypto paths from src/server/api/backup.ts.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';

const PASSWORD = 'test-password-123';
const WRONG_PASSWORD = 'wrong-password-456';

function encryptBackup(plaintext: string, password: string) {
  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { salt, nonce, ciphertext: ct, tag };
}

function decryptBackup(b: ReturnType<typeof encryptBackup>, password: string): string {
  const key = crypto.scryptSync(password, b.salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, b.nonce);
  decipher.setAuthTag(b.tag);
  return Buffer.concat([decipher.update(b.ciphertext), decipher.final()]).toString('utf8');
}

describe('backup encryption', () => {
  const payload = JSON.stringify({ chats: [{ id: 'c1', title: 'Test' }] });

  it('round-trips with the correct password', () => {
    const enc = encryptBackup(payload, PASSWORD);
    const dec = decryptBackup(enc, PASSWORD);
    expect(dec).toBe(payload);
  });

  it('rejects the wrong password (auth tag failure)', () => {
    const enc = encryptBackup(payload, PASSWORD);
    expect(() => decryptBackup(enc, WRONG_PASSWORD)).toThrow();
  });

  it('rejects tampered ciphertext', () => {
    const enc = encryptBackup(payload, PASSWORD);
    // Flip a byte in the ciphertext.
    enc.ciphertext[0] ^= 0xFF;
    expect(() => decryptBackup(enc, PASSWORD)).toThrow();
  });

  it('rejects a truncated archive', () => {
    const enc = encryptBackup(payload, PASSWORD);
    enc.ciphertext = enc.ciphertext.subarray(0, enc.ciphertext.length - 5);
    expect(() => decryptBackup(enc, PASSWORD)).toThrow();
  });
});
