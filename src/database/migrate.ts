/**
 * Runner de migraciones SQL manuales (estricto).
 *
 *   pnpm db:migrate              → aplica migraciones pendientes (up)
 *   pnpm db:migrate:status       → muestra el estado de cada migración
 *   pnpm db:migrate:new <nombre> → crea NNN_<nombre>.sql vacío con plantilla
 *
 * Reglas:
 *  1. Archivos `NNN_descripcion.sql` en src/database/migrations, orden numérico, sin duplicados.
 *  2. Cada migración corre en SU PROPIA transacción con un advisory lock
 *     (dos procesos concurrentes no aplican la misma migración).
 *  3. Se guarda el SHA-256 del archivo. Si un archivo ya aplicado cambia, el runner
 *     ABORTA: las migraciones aplicadas son inmutables; cree una nueva.
 *  4. No existe "down": las reversiones son migraciones nuevas hacia adelante.
 *  5. Una migración registrada por Docker init (checksum NULL) se adopta como línea base.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { QueryTypes, type Transaction } from 'sequelize';
import { sequelize } from '../core/config/database.js';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'src/database/migrations');
const FILE_PATTERN = /^(\d{3,})_[a-z0-9_]+\.sql$/;
const ADVISORY_LOCK_KEY = 4_815_162_342; // constante arbitraria compartida por todos los runners

interface MigrationFile {
  name: string;
  version: number;
  sql: string;
  checksum: string;
}

interface AppliedMigration {
  name: string;
  checksum: string | null;
  applied_at: Date;
  applied_by: string;
}

class MigrationError extends Error {
  override name = 'MigrationError';
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function ensureMigrationsTable(): Promise<void> {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text        NOT NULL,
      checksum    char(64),
      applied_at  timestamptz NOT NULL DEFAULT now(),
      applied_by  text        NOT NULL DEFAULT current_user,
      CONSTRAINT pk_schema_migrations PRIMARY KEY (name)
    );
  `);
}

async function loadMigrationFiles(): Promise<MigrationFile[]> {
  const entries = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql'));

  const invalid = entries.filter((file) => !FILE_PATTERN.test(file));
  if (invalid.length > 0) {
    throw new MigrationError(
      `Nombres de migración inválidos (formato NNN_descripcion_en_snake.sql): ${invalid.join(', ')}`,
    );
  }

  const files = await Promise.all(
    entries.map(async (name): Promise<MigrationFile> => {
      // Normalizar CRLF → LF para que el checksum no dependa del SO.
      const sql = (await readFile(path.join(MIGRATIONS_DIR, name), 'utf8')).replace(/\r\n/g, '\n');
      const version = Number(FILE_PATTERN.exec(name)?.[1]);
      return { name, version, sql, checksum: sha256(sql) };
    }),
  );

  files.sort((a, b) => a.version - b.version);

  for (let i = 1; i < files.length; i++) {
    const previous = files[i - 1]!;
    const current = files[i]!;
    if (previous.version === current.version) {
      throw new MigrationError(`Número de versión duplicado: ${previous.name} y ${current.name}`);
    }
  }

  return files;
}

async function loadApplied(transaction?: Transaction): Promise<Map<string, AppliedMigration>> {
  const rows = await sequelize.query<AppliedMigration>(
    'SELECT name, checksum, applied_at, applied_by FROM schema_migrations ORDER BY name',
    { type: QueryTypes.SELECT, transaction },
  );
  return new Map(rows.map((row) => [row.name, row]));
}

/** Valida integridad: archivos aplicados existen y no fueron modificados. */
function verifyIntegrity(files: MigrationFile[], applied: Map<string, AppliedMigration>): MigrationFile[] {
  const byName = new Map(files.map((file) => [file.name, file]));
  const problems: string[] = [];

  for (const row of applied.values()) {
    const file = byName.get(row.name);
    if (!file) {
      problems.push(`• ${row.name}: aplicada en la BD pero el archivo no existe en el repositorio.`);
    } else if (row.checksum !== null && row.checksum.trim() !== file.checksum) {
      problems.push(`• ${row.name}: el archivo fue MODIFICADO después de aplicarse (checksum distinto).`);
    }
  }

  if (problems.length > 0) {
    throw new MigrationError(
      `Integridad de migraciones comprometida:\n${problems.join('\n')}\n` +
        'Restaure los archivos originales y cree una migración nueva con los cambios.',
    );
  }

  return files.filter((file) => applied.has(file.name) && applied.get(file.name)!.checksum === null);
}

async function adoptBaseline(files: MigrationFile[]): Promise<void> {
  for (const file of files) {
    await sequelize.query(
      'UPDATE schema_migrations SET checksum = :checksum WHERE name = :name AND checksum IS NULL',
      { replacements: { checksum: file.checksum, name: file.name } },
    );
    console.log(`  ↺ ${file.name} (línea base registrada por Docker: checksum adoptado)`);
  }
}

async function applyMigration(file: MigrationFile): Promise<boolean> {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(:key)', {
      replacements: { key: ADVISORY_LOCK_KEY },
      transaction,
    });

    // Re-verificar dentro del lock: otro proceso pudo aplicarla mientras esperábamos.
    const [already] = await sequelize.query<{ checksum: string | null }>(
      'SELECT checksum FROM schema_migrations WHERE name = :name',
      { replacements: { name: file.name }, type: QueryTypes.SELECT, transaction },
    );
    if (already) return false;

    // Sin `replacements` ni `bind`: el SQL se envía tal cual (admite $$, múltiples sentencias, etc.).
    await sequelize.query(file.sql, { transaction });

    await sequelize.query(
      `INSERT INTO schema_migrations (name, checksum, applied_by)
       VALUES (:name, :checksum, current_user)
       ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now(), applied_by = current_user`,
      { replacements: { name: file.name, checksum: file.checksum }, transaction },
    );
    return true;
  });
}

async function up(): Promise<void> {
  await ensureMigrationsTable();
  const files = await loadMigrationFiles();
  const applied = await loadApplied();

  await adoptBaseline(verifyIntegrity(files, applied));

  const pending = files.filter((file) => !applied.has(file.name));
  if (pending.length === 0) {
    console.log('✔ Base de datos al día. No hay migraciones pendientes.');
    return;
  }

  console.log(`Aplicando ${pending.length} migración(es)...`);
  for (const file of pending) {
    const started = Date.now();
    try {
      const appliedNow = await applyMigration(file);
      console.log(
        appliedNow
          ? `  ✔ ${file.name} (${Date.now() - started} ms)`
          : `  • ${file.name} ya fue aplicada por otro proceso`,
      );
    } catch (error) {
      console.error(`  ✖ ${file.name} falló; la transacción fue revertida.`);
      throw error;
    }
  }
  console.log('✔ Migraciones completadas.');
}

async function status(): Promise<void> {
  await ensureMigrationsTable();
  const files = await loadMigrationFiles();
  const applied = await loadApplied();
  const fileNames = new Set(files.map((file) => file.name));

  const rows = files.map((file) => {
    const row = applied.get(file.name);
    let state = 'PENDIENTE';
    if (row) {
      if (row.checksum === null) state = 'APLICADA (línea base, sin checksum)';
      else state = row.checksum.trim() === file.checksum ? 'APLICADA' : 'MODIFICADA ⚠';
    }
    return {
      migracion: file.name,
      estado: state,
      aplicada_en: row ? new Date(row.applied_at).toISOString() : '',
      por: row?.applied_by ?? '',
    };
  });

  for (const row of applied.values()) {
    if (!fileNames.has(row.name)) {
      rows.push({
        migracion: row.name,
        estado: 'HUÉRFANA ⚠ (sin archivo)',
        aplicada_en: new Date(row.applied_at).toISOString(),
        por: row.applied_by,
      });
    }
  }

  console.table(rows);
}

async function create(rawName: string | undefined): Promise<void> {
  const slug = (rawName ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) {
    throw new MigrationError('Indique un nombre: pnpm db:migrate:new agregar_columna_x');
  }

  const files = await loadMigrationFiles();
  const nextVersion = (files.at(-1)?.version ?? 0) + 1;
  const name = `${String(nextVersion).padStart(3, '0')}_${slug}.sql`;
  const target = path.join(MIGRATIONS_DIR, name);

  const template = `-- =============================================================================
-- ${name}
-- Fecha: ${new Date().toISOString().slice(0, 10)}
-- Descripción: <qué cambia y por qué>
--
-- • Se ejecuta dentro de una transacción: NO incluya BEGIN/COMMIT.
-- • Use nombres de restricciones explícitos (fk_, uq_, ck_, ix_).
-- • Si crea una tabla con updated_at, agregue su trigger fn_set_updated_at().
-- • Una vez aplicada en un entorno compartido, este archivo es INMUTABLE.
-- =============================================================================

`;
  await writeFile(target, template, { flag: 'wx' });
  console.log(`✔ Migración creada: ${path.relative(process.cwd(), target)}`);
}

async function main(): Promise<void> {
  const [command = 'up', ...args] = process.argv.slice(2);
  switch (command) {
    case 'up':
      await up();
      break;
    case 'status':
      await status();
      break;
    case 'new':
      await create(args.join('_'));
      return; // no requiere conexión
    default:
      throw new MigrationError(`Comando desconocido "${command}". Use: up | status | new <nombre>`);
  }
}

main()
  .then(async () => {
    await sequelize.close();
  })
  .catch(async (error: unknown) => {
    if (error instanceof MigrationError) {
      console.error(`\n✖ ${error.message}\n`);
    } else {
      console.error('\n✖ Error ejecutando migraciones:', error);
    }
    await sequelize.close().catch(() => undefined);
    process.exitCode = 1;
  });
