/**
 * Gnito — secrets vault.
 *
 * Stores provider API keys encrypted at rest. The master key is derived
 * from a random 32-byte value generated on first run and stored in a
 * separate file (mode 0600) alongside the vault. We disclose honestly in
 * docs/security.md that this protects against casual file reads, but a
 * determined attacker with filesystem access can extract both files.
 *
 * For a stronger model the user can set GNITO_MASTER_KEY env (e.g., backed
 * by an OS keychain agent) — same crypto, external key source.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, ensureDataDir } from '../config.js';

const VAULT_FILE = CONFIG.secretsVaultPath;
const MASTER_KEY_FILE = path.join(CONFIG.dataDir, '.gnito-master-key');

function loadOrCreateMasterKey(): Buffer {
  if (process.env.GNITO_MASTER_KEY) {
    return Buffer.from(process.env.GNITO_MASTER_KEY, 'hex');
  }
  ensureDataDir();
  if (fs.existsSync(MASTER_KEY_FILE)) {
    return Buffer.from(fs.readFileSync(MASTER_KEY_FILE, 'utf8').trim(), 'hex');
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(MASTER_KEY_FILE, key.toString('hex'), { mode: 0o600 });
  return key;
}

const MASTER_KEY = loadOrCreateMasterKey();

interface VaultPayload {
  [providerId: string]: string; // encrypted API key (base64)
}

function readVault(): VaultPayload {
  ensureDataDir();
  if (!fs.existsSync(VAULT_FILE)) return {};
  const raw = fs.readFileSync(VAULT_FILE);
  // File format: [12-byte nonce][ciphertext][16-byte GCM tag]
  const nonce = raw.subarray(0, 12);
  const ciphertext = raw.subarray(12, raw.length - 16);
  const tag = raw.subarray(raw.length - 16);
  const cipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, nonce);
  cipher.setAuthTag(tag);
  const plaintext = Buffer.concat([cipher.update(ciphertext), cipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

function writeVault(vault: VaultPayload): void {
  ensureDataDir();
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(vault), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  fs.writeFileSync(VAULT_FILE, Buffer.concat([nonce, ciphertext, tag]), { mode: 0o600 });
}

/** Store (or overwrite) an encrypted secret under a namespaced identifier. */
export function setSecret(secretId: string, secret: string): void {
  const v = readVault();
  v[secretId] = secret;
  writeVault(v);
}

/** Get a stored secret, or null. */
export function getSecret(secretId: string): string | null {
  const v = readVault();
  return v[secretId] ?? null;
}

/** Delete a stored secret. */
export function deleteSecret(secretId: string): void {
  const v = readVault();
  delete v[secretId];
  writeVault(v);
}

/** Store (or overwrite) the API key for a provider. */
export function setProviderSecret(providerId: string, apiKey: string): void { setSecret(providerId, apiKey); }
/** Get the stored API key for a provider, or null. */
export function getProviderSecret(providerId: string): string | null { return getSecret(providerId); }
/** Delete the stored API key for a provider. */
export function deleteProviderSecret(providerId: string): void { deleteSecret(providerId); }

/**
 * Clear all secrets — used by "delete all data" and by incognito session
 * teardown if the user opted to forget any temp credentials.
 */
export function clearAllSecrets(): void {
  writeVault({});
}
