/**
 * Conexión única de Sequelize a PostgreSQL.
 *
 * REGLA DEL PROYECTO: el esquema se gestiona EXCLUSIVAMENTE con migraciones SQL
 * en `src/database/migrations` (pnpm db:migrate). `sequelize.sync()` está
 * deshabilitado a propósito para que nadie altere la BD desde los modelos.
 */
import { Sequelize, type Options } from 'sequelize';
import { env } from './env.js';
import { logger } from '../logger.js';

const options: Options = {
  dialect: 'postgres',
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  username: env.DB_USER,
  password: env.DB_PASSWORD,
  logging: env.DB_LOGGING ? (sql: string) => logger.debug(sql) : false,
  benchmark: env.DB_LOGGING,
  pool: {
    max: env.DB_POOL_MAX,
    min: 0,
    acquire: 30_000,
    idle: 10_000,
  },
  dialectOptions: {
    application_name: 'horas-sociales-core-backend',
    statement_timeout: 30_000,
    ...(env.DB_SSL
      ? { ssl: { require: true, rejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED } }
      : {}),
  },
  define: {
    // Atributos camelCase en TS  <->  columnas snake_case en PostgreSQL.
    underscored: true,
    freezeTableName: true,
    timestamps: true,
  },
};

export const sequelize = new Sequelize(options);

// Candado contra sincronización automática del esquema.
sequelize.sync = async () => {
  throw new Error(
    'sequelize.sync() está deshabilitado. Cree una migración SQL en src/database/migrations y ejecute `pnpm db:migrate`.',
  );
};

/** Verifica conectividad; se usa al arrancar el servidor. */
export async function assertDatabaseConnection(): Promise<void> {
  await sequelize.authenticate();
  logger.info(`Conectado a PostgreSQL ${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`);
}

/** Cierra el pool de conexiones (apagado ordenado / scripts). */
export async function closeDatabase(): Promise<void> {
  await sequelize.close();
}
