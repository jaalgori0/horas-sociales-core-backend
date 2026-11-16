/**
 * Carga y valida las variables de entorno UNA sola vez al arrancar.
 * Cualquier módulo debe importar `env` desde aquí y nunca leer `process.env` directamente.
 */
import 'dotenv/config';
import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((value) => value === 'true' || value === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_PREFIX: z
    .string()
    .regex(/^\/[a-z0-9/_-]*$/i, 'API_PREFIX debe iniciar con "/"')
    .default('/api/v1'),
  CORS_ORIGINS: z.string().default('*'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // Tamaño máximo del cuerpo JSON (las imágenes llegan como data URL base64).
  JSON_BODY_LIMIT: z
    .string()
    .regex(/^\d+(kb|mb)$/i, 'JSON_BODY_LIMIT debe ser como "8mb" o "500kb"')
    .default('8mb'),

  // Importación masiva (POST /imports): archivos PDF/XLS en memoria, nunca en disco.
  IMPORT_MAX_FILE_MB: z.coerce.number().int().min(1).max(100).default(15),
  IMPORT_MAX_FILES: z.coerce.number().int().min(1).max(50).default(20),

  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_LOGGING: booleanFromString,
  DB_SSL: booleanFromString,
  DB_SSL_REJECT_UNAUTHORIZED: booleanFromString.default('true'),

  // Autenticación de usuarios administrativos (tabla users).
  // AUTH_ALLOW_REGISTER=false cierra POST /auth/register (recomendado en producción).
  AUTH_ALLOW_REGISTER: booleanFromString.default('true'),
  // Rol que recibe una cuenta creada por autoregistro. Nunca ADMIN por defecto.
  AUTH_REGISTER_ROLE: z.enum(['ADMIN', 'COORDINADOR', 'CONSULTA']).default('CONSULTA'),

  // Opcionales a nivel de esquema para que `pnpm db:migrate` no las exija;
  // el servidor HTTP las valida al arrancar (ver core/security/crypto.ts).
  DUI_HASH_KEY: z.string().min(32, 'DUI_HASH_KEY debe tener al menos 32 caracteres').optional(),
  DUI_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'DUI_ENCRYPTION_KEY debe ser hexadecimal de 64 caracteres (32 bytes)')
    .optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
  // No se usa el logger para evitar dependencias circulares durante el arranque.
  console.error(`\n❌ Variables de entorno inválidas:\n${issues}\n\nRevise su archivo .env (vea .env.example).\n`);
  process.exit(1);
}

export const env = Object.freeze({
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === 'production',
  corsOrigins: parsed.data.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
});

export type Env = typeof env;
