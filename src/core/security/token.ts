/**
 * Tokens de sesión firmados con HMAC-SHA256 (sin dependencias externas).
 *
 *   formato:  v1.<payload base64url>.<firma base64url>
 *   payload:  { sub: id de usuario, iat, exp }  (segundos Unix)
 *   firma:    HMAC-SHA256(AUTH_SECRET, "v1.<payload>")
 *
 * El token solo prueba QUIÉN es el usuario y hasta cuándo vale. El rol y si la
 * cuenta sigue activa se leen de la BD en cada petición (ver require-auth.ts),
 * así que desactivar un usuario corta su acceso de inmediato.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

const VERSION = 'v1';

export interface TokenPayload {
  sub: string;
  iat: number;
  exp: number;
}

function getSecret(): Buffer {
  if (!env.AUTH_SECRET) {
    throw new Error('Falta AUTH_SECRET en el entorno (vea .env.example).');
  }
  return Buffer.from(env.AUTH_SECRET, 'utf8');
}

/** Falla al arrancar si el secreto no está configurado (fail-fast). */
export function assertAuthConfig(): void {
  getSecret();
}

function sign(data: string): Buffer {
  return createHmac('sha256', getSecret()).update(data, 'utf8').digest();
}

export function issueToken(userId: string, now = Date.now()): { token: string; expiresAt: Date } {
  const iat = Math.floor(now / 1000);
  const exp = iat + env.AUTH_TOKEN_TTL_HOURS * 3600;
  const payload = Buffer.from(JSON.stringify({ sub: userId, iat, exp } satisfies TokenPayload)).toString('base64url');
  const data = `${VERSION}.${payload}`;
  return { token: `${data}.${sign(data).toString('base64url')}`, expiresAt: new Date(exp * 1000) };
}

/** Payload si la firma es válida y no venció; `null` en cualquier otro caso. */
export function verifyToken(token: string, now = Date.now()): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [version, payload, signature] = parts as [string, string, string];

  const expected = sign(`${version}.${payload}`);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<TokenPayload>;
    if (typeof data.sub !== 'string' || typeof data.exp !== 'number' || typeof data.iat !== 'number') return null;
    if (data.exp * 1000 <= now) return null;
    return { sub: data.sub, iat: data.iat, exp: data.exp };
  } catch {
    return null;
  }
}
