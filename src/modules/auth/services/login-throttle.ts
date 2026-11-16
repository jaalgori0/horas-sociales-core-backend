/**
 * Limitador de intentos fallidos de login, en memoria (por proceso).
 * Clave = IP + correo. Tras MAX_FAILURES fallos en WINDOW_MS se bloquea esa
 * clave hasta que la ventana expire. Un login correcto limpia la clave.
 *
 * Suficiente para una sola instancia; con varias réplicas debe moverse a un
 * almacén compartido (p. ej. Redis o una tabla).
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const MAX_KEYS = 10_000;

interface Entry {
  failures: number;
  firstAt: number;
}

const entries = new Map<string, Entry>();

function prune(now: number): void {
  for (const [key, entry] of entries) {
    if (now - entry.firstAt > WINDOW_MS) entries.delete(key);
  }
}

export const loginThrottle = {
  /** Segundos que faltan para poder reintentar, o 0 si está permitido. */
  retryAfter(key: string, now = Date.now()): number {
    const entry = entries.get(key);
    if (!entry) return 0;
    if (now - entry.firstAt > WINDOW_MS) {
      entries.delete(key);
      return 0;
    }
    return entry.failures >= MAX_FAILURES ? Math.ceil((entry.firstAt + WINDOW_MS - now) / 1000) : 0;
  },

  fail(key: string, now = Date.now()): void {
    if (entries.size >= MAX_KEYS) prune(now);
    const entry = entries.get(key);
    if (!entry || now - entry.firstAt > WINDOW_MS) entries.set(key, { failures: 1, firstAt: now });
    else entry.failures += 1;
  },

  reset(key: string): void {
    entries.delete(key);
  },
};
