/**
 * Protección del DUI (dato personal sensible):
 *  - dui_hash    = HMAC-SHA256(dui_normalizado, DUI_HASH_KEY)   → unicidad y búsqueda exacta.
 *  - dui_cifrado = AES-256-GCM(dui_normalizado, DUI_ENCRYPTION_KEY) → recuperación controlada.
 *
 * Formato de dui_cifrado: [versión(1)][iv(12)][authTag(16)][ciphertext(n)]
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

const CIPHER_VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

interface DuiKeys {
  hashKey: Buffer;
  encryptionKey: Buffer;
}

let cachedKeys: DuiKeys | undefined;

function getKeys(): DuiKeys {
  if (cachedKeys) return cachedKeys;
  if (!env.DUI_HASH_KEY || !env.DUI_ENCRYPTION_KEY) {
    throw new Error('Faltan DUI_HASH_KEY y/o DUI_ENCRYPTION_KEY en el entorno (vea .env.example).');
  }
  cachedKeys = {
    hashKey: Buffer.from(env.DUI_HASH_KEY, 'utf8'),
    encryptionKey: Buffer.from(env.DUI_ENCRYPTION_KEY, 'hex'),
  };
  return cachedKeys;
}

/** Falla al arrancar si las claves no están configuradas (fail-fast). */
export function assertSecurityConfig(): void {
  getKeys();
}

/** "012345678" | "01234567-8" → "01234567-8". Lanza si no son 9 dígitos. */
export function normalizeDui(dui: string): string {
  const digits = dui.replace(/\D/g, '');
  if (digits.length !== 9) {
    throw new Error('El DUI debe contener 9 dígitos');
  }
  return `${digits.slice(0, 8)}-${digits.slice(8)}`;
}

export function hashDui(dui: string): Buffer {
  return createHmac('sha256', getKeys().hashKey).update(normalizeDui(dui), 'utf8').digest();
}

export function encryptDui(dui: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', getKeys().encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(normalizeDui(dui), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([CIPHER_VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptDui(payload: Buffer): string {
  if (payload.length <= 1 + IV_LENGTH + TAG_LENGTH || payload[0] !== CIPHER_VERSION) {
    throw new Error('Formato de DUI cifrado no reconocido');
  }
  const iv = payload.subarray(1, 1 + IV_LENGTH);
  const tag = payload.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
  const ciphertext = payload.subarray(1 + IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', getKeys().encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** "01234567-8" → "*****567-8" para mostrar en interfaces. */
export function maskDui(dui: string): string {
  const normalized = normalizeDui(dui);
  return `*****${normalized.slice(5)}`;
}
