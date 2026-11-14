# ETL histórico del CSS → base unificada

Migra el histórico del Centro de Servicio Social a la base PostgreSQL unificada:

- **9 PDFs** "Detalle de Horas por Proyecto" (uno por carrera: `Arquitectura.pdf`, `Civil.pdf`, …)
- **1 Excel** "Memoria de Labores del CSS" (`ReporteEstadisticoCSS(11).xls`)

```
data/*.pdf, *.xls ──(1) extracción en Node──▶ staging.* (texto crudo)
                                                  │
                         (2) validación y carga en SQL, una transacción
                                                  ▼
          faculties · careers · institutions · projects · students
          project_enrollments · hour_movements          (esquema maestro)
```

Esta guía describe la **carga inicial en una base de producción vacía**.

---

## 1. Requisitos

| Requisito | Detalle |
|---|---|
| Equipo | El de un operador con acceso de red a la base de producción. **No** se ejecuta dentro del contenedor de la app: necesita las dependencias de desarrollo (`tsx`). |
| Software | Node.js ≥ 20.11 y pnpm ≥ 9 |
| Base de datos | PostgreSQL ≥ 13, **vacía**. El usuario debe poder crear esquemas, tablas, funciones y triggers, y las extensiones `pgcrypto` y `citext` (la migración 001 las crea; en bases administradas suelen estar permitidas o las crea un administrador). |
| Archivos fuente | Los 10 archivos en `data/`, en la raíz del repositorio. La carpeta está en `.gitignore` porque contiene datos personales: **nunca la versione**. |

## 2. Preparación

```bash
pnpm install                    # incluye devDependencies (tsx)
cp .env.example .env            # y edítelo:
```

Variables de `.env` que usa el ETL:

```ini
DB_HOST=<host de producción>
DB_PORT=5432
DB_NAME=<base>
DB_USER=<usuario>
DB_PASSWORD=<contraseña>
DB_SSL=true                     # si la base administrada lo exige
```

Las claves `DUI_*` no se necesitan para el ETL: las fuentes no traen DUI.

Confirme que la base está vacía y que apunta a la correcta:

```bash
psql "host=$DB_HOST port=$DB_PORT dbname=$DB_NAME user=$DB_USER sslmode=require" \
  -c "SELECT count(*) AS tablas FROM information_schema.tables WHERE table_schema = 'public';"
# Esperado: 0
```

## 3. Secuencia de ejecución

Ejecute los pasos **en este orden**. Detenga el proceso si un paso termina con un código de salida distinto de `0`.

| Código | Significado |
|---|---|
| `0` | Correcto |
| `1` | Error: no se aplicó nada |
| `2` | Terminó, pero hay algo que revisar (ver salida) |

```bash
# 1. Esquema maestro: 001 (base) + 002 (soporte histórico CSS) + 003 (catálogo UCA)
pnpm db:migrate
pnpm db:migrate:status          # las 3 en estado APLICADA

# 2. Crear el esquema temporal staging
pnpm etl:staging:init

# 3. Extraer los archivos: primero en seco, luego de verdad
pnpm etl:staging:load --dry-run # todas las filas con ✔ y ninguna "línea sin clasificar"
pnpm etl:staging:load

# 4. Transformar y cargar al maestro: primero en seco (revierte), luego de verdad
pnpm etl:transform --dry-run    # "Sin rechazos" y todos los controles con ✔
pnpm etl:transform              # termina en "Carga confirmada (COMMIT)"

# 5. Verificar (sección 4) y, solo entonces, eliminar staging
pnpm etl:staging:drop
```

### Qué revisar en cada dry-run

**`etl:staging:load --dry-run`** compara lo extraído con los totales impresos en los reportes:

- **Por archivo:** filas y horas (PDF), o proyectos y alumnos (Excel).
- **Por bloque de proyecto:** cada total que imprime el PDF.
- **Por área:** cada subtotal del Excel.

Un `✖` o una "línea sin clasificar" significa que el formato del reporte cambió. No continúe.

**`etl:transform --dry-run`** ejecuta toda la transformación y la revierte al final. Muestra:

- **Rechazos:** filas en cuarentena (`staging.rechazos`), que **no** se cargan. Deben ser 0.
- **Conciliación:** lo válido en staging frente a lo que quedó en el maestro. Todo debe tener `✔`.
- **Correcciones automáticas** (`staging.ajustes`): fechas de fin de proyecto corregidas (ver sección 5).
- **Mapeo de carreras:** carrera del PDF → carrera oficial → facultad, con la cantidad de estudiantes.

## 4. Verificación posterior a la carga

Con los archivos actuales los valores esperados son:

| Control | Esperado |
|---|---|
| Facultades / carreras (catálogo 003) | 3 / 22 |
| Instituciones | 134 |
| Proyectos | 215 |
| Estudiantes | 239 |
| Participaciones | 270 (163 EN_CURSO · 105 FINALIZADA · 2 RETIRADA) |
| Movimientos de horas | 105 |
| Total de horas | 29 861 |
| `staging.rechazos` | 0 |

```sql
SELECT count(*) FROM staging.rechazos;                                   -- 0 (antes del drop)
SELECT (SELECT count(*) FROM faculties) AS facultades, (SELECT count(*) FROM careers) AS carreras,
       (SELECT count(*) FROM institutions) AS instituciones, (SELECT count(*) FROM projects) AS proyectos,
       (SELECT count(*) FROM students) AS estudiantes, (SELECT count(*) FROM project_enrollments) AS participaciones,
       (SELECT count(*) FROM hour_movements) AS movimientos, (SELECT sum(horas) FROM hour_movements) AS horas;

-- Estudiantes por facultad (por llaves foráneas, no por texto)
SELECT f.nombre AS facultad, c.nombre AS carrera, count(s.id) AS estudiantes
FROM faculties f JOIN careers c ON c.faculty_id = f.id
LEFT JOIN students s ON s.career_id = c.id
GROUP BY 1, 2 HAVING count(s.id) > 0 ORDER BY 1, 2;
```

Todo lo que inserta el ETL queda en `auditoria` con `actor = 'etl:css-historico'`.

## 5. Reglas de negocio aplicadas

| Tema | Regla |
|---|---|
| Nombre del estudiante | Se guarda **literal**, como viene en el reporte (`APELLIDO1, APELLIDO2 NOMBRES`), en `students.nombre_completo`. `nombres`/`apellidos` quedan en `NULL` hasta que se completen en la app, siempre los dos juntos (migración 002). |
| Correo institucional | Se deriva como `<carnet>@uca.edu.sv`. |
| Carrera y facultad | La carrera del PDF, sin sufijo de modalidad, se traduce con `staging.map_carreras` a una carrera del catálogo oficial (003). La facultad sale de `careers.faculty_id`. Licenciatura en Diseño pertenece a Ciencias Sociales y Humanidades. |
| Sufijos de modalidad | `(presencial)`, `(semipresencial)` y `(virtual)` se eliminan de los reportes. `ck_careers_nombre_sin_modalidad` los prohíbe en el catálogo. |
| Identidad del proyecto | `(institution_id, correlativo_css)`. El correlativo solo **no** es único. |
| PDF frente a Excel | El PDF es la fuente oficial (nombres, participaciones, horas). El Excel completa las fechas y el área de los proyectos, y aporta los proyectos sin estudiantes. |
| Mojibake (`ESPAÃ?A`) | Viene dañado desde el sistema de origen, tanto en el PDF como en el Excel. Se corrige con `staging.map_mojibake`. Si queda una `Ã` sin regla, la fila va a cuarentena. |
| `01/01/1900` | Significa "sin fecha". |
| Estudiante "Activo" | Participación `EN_CURSO`, sin fecha de cierre y **sin** movimiento de horas. |
| Estudiante "Finalizado" | Participación `FINALIZADA` (cierre = fecha de fin) y un movimiento de horas con fecha = fecha de fin. |
| Estudiante "Abandonado" | Participación `RETIRADA`, sin horas. |
| Proyecto con fin anterior al inicio (Excel) | Se conserva el inicio y se suman años al fin hasta que fin ≥ inicio. Cada corrección queda en `staging.ajustes`. |
| Estado del proyecto | `FINALIZADO` solo si su fecha de cierre ya pasó. Si no, `ACTIVO`. |
| Naturaleza de las horas | `EXTERNA` (las fuentes no lo indican). |

## 6. Reejecución e idempotencia

- Cada paso se puede repetir sin efectos acumulados.
- `etl:staging:load` reemplaza el contenido de staging.
- `etl:transform` usa `ON CONFLICT` sobre llaves naturales. Las horas llevan un `solicitud_id` determinista, por lo que **nunca se duplican**. Una segunda corrida sin cambios no genera ningún INSERT ni UPDATE.
- Si corrige una regla (por ejemplo, una entrada de `map_mojibake`), basta con volver a ejecutar `etl:transform`: solo se actualizan las filas afectadas.
- Los estudiantes que ya completaron su perfil en la app (`nombres` no nulo) **no** se sobrescriben.
- El estado de un proyecto depende de la fecha de ejecución. Si se reejecuta después de la fecha de cierre de un proyecto, ese proyecto pasa a `FINALIZADO`.
- Para reejecutar después de `etl:staging:drop`, empiece de nuevo en el paso 2 (`etl:staging:init`).

## 7. Problemas frecuentes

| Mensaje | Causa y solución |
|---|---|
| `Formato inesperado: … la columna "X" no está donde se esperaba` | El reporte cambió de formato. Hay que ajustar `COLUMNS` (PDF) o `HEADER`/`DATA_COLUMNS` (Excel) en `src/etl/extract/`. |
| `El esquema "staging" no existe` | Falta `pnpm etl:staging:init`. |
| `Falta la migración 002…` / `Carreras del mapa que no existen en el catálogo oficial` | Falta `pnpm db:migrate`, o se agregó una carrera al mapa que no está en la migración 003. |
| `Filas en cuarentena` (código 2) | Revise `SELECT * FROM staging.rechazos` y corrija la regla o el archivo fuente. Luego repita desde `etl:staging:load` (si cambió el archivo) o desde `etl:transform`. |
| Una carrera nueva en los reportes | Agréguela al catálogo con una **migración nueva** y su traducción en `staging.map_carreras` (`src/etl/sql/transform_load.sql`). |

## 8. Después de la carga

1. `pnpm etl:staging:drop`: staging contiene nombres y carnets en bruto.
2. Elimine la copia local de `data/` del equipo del operador, o guárdela en un lugar con acceso restringido.
3. Archivos involucrados, para auditoría:
   - `src/etl/sql/staging_schema.sql`
   - `src/etl/sql/transform_load.sql`
   - `src/database/migrations/002_*.sql` y `003_*.sql`
