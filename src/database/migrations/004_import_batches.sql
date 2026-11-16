-- =============================================================================
-- 004_import_batches.sql
-- Descripción: importación masiva desde la API (POST /imports) con vista previa.
--
-- A diferencia del ETL histórico (esquema `staging`, desechable y de un solo uso),
-- estas tablas son permanentes y TODO va aislado por lote (`batch_id`):
--   • Dos vistas previas simultáneas nunca comparten filas.
--   • La confirmación toma un advisory lock y vuelve a clasificar contra el estado
--     actual del maestro antes de escribir (ver src/modules/imports/).
--   • Un lote confirmado conserva sus filas e ítems: es el historial de la importación.
--
-- Reglas de carga (documentadas en src/modules/imports/sql/classify.sql):
--   1. Cero sobrescritura: lo que ya existe se IGNORA (ON CONFLICT DO NOTHING).
--   2. Solo se completan campos en NULL; el trigger fn_auditoria registra cada cambio.
--   3. Sin topes de horas: las participaciones nuevas suman al historial del estudiante.
--   4. Participación existente con datos distintos → CONFLICTO (revisión manual).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Lotes y archivos
-- -----------------------------------------------------------------------------
CREATE TABLE import_batches (
    id              uuid        NOT NULL DEFAULT gen_random_uuid(),
    estado          text        NOT NULL DEFAULT 'PREVISUALIZADO',
    creado_por      text        NOT NULL DEFAULT fn_current_actor(),
    creado_en       timestamptz NOT NULL DEFAULT now(),
    -- Una vista previa vieja ya no describe el maestro: pasada esta fecha no se confirma.
    expira_en       timestamptz NOT NULL DEFAULT now() + interval '24 hours',
    confirmado_por  text,
    confirmado_en   timestamptz,
    -- md5 de la clasificación mostrada; la confirmación exige que siga igual.
    huella          text,
    resumen         jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- conteos por entidad y estado
    resultado       jsonb,                                       -- filas escritas al confirmar
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_import_batches PRIMARY KEY (id),
    CONSTRAINT ck_import_batches_estado CHECK (estado IN ('PREVISUALIZADO', 'CONFIRMADO', 'DESCARTADO')),
    CONSTRAINT ck_import_batches_confirmado CHECK ((estado = 'CONFIRMADO') = (confirmado_en IS NOT NULL))
);
CREATE INDEX ix_import_batches_creado_en ON import_batches (creado_en DESC);
CREATE INDEX ix_import_batches_expira_en ON import_batches (expira_en) WHERE estado = 'PREVISUALIZADO';
COMMENT ON TABLE import_batches IS 'Lotes de importación masiva (PDF/Excel del CSS) subidos por la API.';

CREATE TABLE import_files (
    batch_id       uuid    NOT NULL,
    archivo        text    NOT NULL,
    estado         text    NOT NULL,                    -- 'PROCESADO' | 'RECHAZADO'
    motivo         text,                                -- por qué se rechazó
    tipo           text,                                -- 'PDF_DETALLE_HORAS' | 'XLS_MEMORIA_LABORES'
    sha256         char(64) NOT NULL,
    bytes          integer NOT NULL,
    paginas        integer,
    titulo         text,
    periodo_desde  text,
    periodo_hasta  text,
    generado_en    text,
    filas          integer NOT NULL DEFAULT 0,
    advertencias   text[]  NOT NULL DEFAULT '{}',       -- descuadres con totales, ya importado, ...
    conciliacion   jsonb   NOT NULL DEFAULT '[]'::jsonb, -- extraído vs totales impresos en el reporte
    CONSTRAINT pk_import_files PRIMARY KEY (batch_id, archivo),
    CONSTRAINT fk_import_files_batch FOREIGN KEY (batch_id)
        REFERENCES import_batches (id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT ck_import_files_estado CHECK (estado IN ('PROCESADO', 'RECHAZADO')),
    CONSTRAINT ck_import_files_motivo CHECK ((estado = 'RECHAZADO') = (motivo IS NOT NULL))
);
CREATE INDEX ix_import_files_sha256 ON import_files (sha256);

-- -----------------------------------------------------------------------------
-- 2. Filas en bruto por lote (mismo contenido que staging.*, más batch_id)
-- -----------------------------------------------------------------------------
CREATE TABLE import_pdf_rows (
    id                bigint  GENERATED ALWAYS AS IDENTITY,
    batch_id          uuid    NOT NULL,
    archivo           text    NOT NULL,
    pagina            integer NOT NULL,
    linea             integer NOT NULL,
    bloque            integer,
    proyecto_nombre   text,
    correlativo       text,
    carnet            text,
    nombre_completo   text,
    fecha_inicio      text,
    fecha_fin         text,
    cod_institucion   text,
    institucion       text,
    carrera           text,
    horas_asignadas   text,
    estado            text,
    texto_original    text    NOT NULL,
    advertencias      text[]  NOT NULL DEFAULT '{}',
    CONSTRAINT pk_import_pdf_rows PRIMARY KEY (id),
    CONSTRAINT fk_import_pdf_rows_file FOREIGN KEY (batch_id, archivo)
        REFERENCES import_files (batch_id, archivo) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT uq_import_pdf_rows_origen UNIQUE (batch_id, archivo, pagina, linea)
);

CREATE TABLE import_xls_rows (
    id                bigint  GENERATED ALWAYS AS IDENTITY,
    batch_id          uuid    NOT NULL,
    archivo           text    NOT NULL,
    hoja              text    NOT NULL,
    fila_excel        integer NOT NULL,
    area              text,
    cod_institucion   text,
    institucion       text,
    correlativo       text,
    proyecto_nombre   text,
    alumnos           text,
    fecha_inicio      text,
    fecha_fin         text,
    advertencias      text[]  NOT NULL DEFAULT '{}',
    CONSTRAINT pk_import_xls_rows PRIMARY KEY (id),
    CONSTRAINT fk_import_xls_rows_file FOREIGN KEY (batch_id, archivo)
        REFERENCES import_files (batch_id, archivo) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT uq_import_xls_rows_origen UNIQUE (batch_id, archivo, hoja, fila_excel)
);

CREATE TABLE import_unparsed_lines (
    id         bigint GENERATED ALWAYS AS IDENTITY,
    batch_id   uuid   NOT NULL,
    archivo    text   NOT NULL,
    ubicacion  text   NOT NULL,
    texto      text   NOT NULL,
    motivo     text   NOT NULL,
    CONSTRAINT pk_import_unparsed_lines PRIMARY KEY (id),
    CONSTRAINT fk_import_unparsed_lines_file FOREIGN KEY (batch_id, archivo)
        REFERENCES import_files (batch_id, archivo) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX ix_import_unparsed_lines_batch ON import_unparsed_lines (batch_id);

-- -----------------------------------------------------------------------------
-- 3. Resultado de la clasificación (se reescribe en cada vista previa/confirmación)
-- -----------------------------------------------------------------------------
-- Una fila por entidad del lote (INSTITUCION, PROYECTO, ESTUDIANTE, PARTICIPACION)
-- o por fila de archivo inválida (FILA_PDF, FILA_XLS).
--   estado: NUEVO       → se insertará.
--           IGNORADO    → ya existe igual; no se toca.
--           ADVERTENCIA → se procesa (insertar/completar/ignorar) pero con observaciones.
--           CONFLICTO   → NO se carga; requiere revisión manual.
--   accion: INSERTAR | COMPLETAR (solo campos NULL) | NINGUNA
CREATE TABLE import_items (
    id           bigint  GENERATED ALWAYS AS IDENTITY,
    batch_id     uuid    NOT NULL,
    entidad      text    NOT NULL,
    clave        text    NOT NULL,
    estado       text    NOT NULL,
    accion       text    NOT NULL,
    motivos      text[]  NOT NULL DEFAULT '{}',
    datos        jsonb   NOT NULL DEFAULT '{}'::jsonb,   -- lo que trae el archivo
    existente    jsonb,                                  -- lo que ya hay en el maestro
    completar    jsonb,                                  -- campo → valor que se llenará (solo NULL)
    ref_id       uuid,                                   -- id del registro existente
    pdf_row_ids  bigint[] NOT NULL DEFAULT '{}',
    xls_row_ids  bigint[] NOT NULL DEFAULT '{}',
    CONSTRAINT pk_import_items PRIMARY KEY (id),
    CONSTRAINT fk_import_items_batch FOREIGN KEY (batch_id)
        REFERENCES import_batches (id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT uq_import_items_clave UNIQUE (batch_id, entidad, clave),
    CONSTRAINT ck_import_items_entidad CHECK (entidad IN
        ('INSTITUCION', 'PROYECTO', 'ESTUDIANTE', 'PARTICIPACION', 'FILA_PDF', 'FILA_XLS')),
    CONSTRAINT ck_import_items_estado CHECK (estado IN ('NUEVO', 'IGNORADO', 'ADVERTENCIA', 'CONFLICTO')),
    CONSTRAINT ck_import_items_accion CHECK (accion IN ('INSERTAR', 'COMPLETAR', 'NINGUNA')),
    CONSTRAINT ck_import_items_conflicto CHECK (estado <> 'CONFLICTO' OR accion = 'NINGUNA'),
    CONSTRAINT ck_import_items_completar CHECK ((accion = 'COMPLETAR') = (completar IS NOT NULL))
);
CREATE INDEX ix_import_items_batch_estado ON import_items (batch_id, estado);

-- -----------------------------------------------------------------------------
-- 4. Reglas de negocio como datos (mismas que src/etl/sql/transform_load.sql)
-- -----------------------------------------------------------------------------
-- Excepciones al cruce directo por nombre normalizado contra `careers`.
-- La carrera se busca primero aquí y, si no está, por fn_normalize_text(nombre).
CREATE TABLE import_map_carreras (
    carrera_reporte  text NOT NULL,                 -- texto del PDF sin sufijo de modalidad
    carrera          text NOT NULL,                 -- careers.nombre
    CONSTRAINT pk_import_map_carreras PRIMARY KEY (carrera_reporte)
);
INSERT INTO import_map_carreras VALUES
    ('LIC. EN DISEÑO', 'Licenciatura en Diseño');

CREATE TABLE import_map_mojibake (
    roto      text NOT NULL,
    correcto  text NOT NULL,
    CONSTRAINT pk_import_map_mojibake PRIMARY KEY (roto)
);
INSERT INTO import_map_mojibake VALUES
    ('ACOMPAÃ?AMIENTO', 'ACOMPAÑAMIENTO'),
    ('ESPAÃ?A',         'ESPAÑA'),
    ('NIÃ?EZ',          'NIÑEZ'),
    ('PLÃ?STICO',       'PLÁSTICO'),
    ('REPARACIÃ?N',     'REPARACIÓN'),
    ('SALVADOREÃ?A',    'SALVADOREÑA'),
    ('SEÃ?ORA',         'SEÑORA');

CREATE TABLE import_map_estados (
    estado_reporte  text    NOT NULL,
    estado          text    NOT NULL,
    requiere_fin    boolean NOT NULL,
    CONSTRAINT pk_import_map_estados PRIMARY KEY (estado_reporte),
    CONSTRAINT ck_import_map_estados_estado CHECK (estado IN ('EN_CURSO', 'FINALIZADA', 'RETIRADA'))
);
INSERT INTO import_map_estados VALUES
    ('Activo',     'EN_CURSO',   false),
    ('Finalizado', 'FINALIZADA', true),
    ('Abandonado', 'RETIRADA',   true);

-- -----------------------------------------------------------------------------
-- 5. Funciones de limpieza (copia permanente de las de staging)
-- -----------------------------------------------------------------------------
-- Lote en proceso: lo fija el servicio con set_config('app.import_id', id, true).
-- Sin valor, falla: ninguna consulta de importación corre sin lote.
CREATE FUNCTION fn_import_actual()
RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT current_setting('app.import_id')::uuid;
$$;

CREATE FUNCTION fn_import_limpiar(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT NULLIF(regexp_replace(btrim(p), '\s+', ' ', 'g'), '');
$$;

-- "dd/mm/aaaa" → date. NULL para el centinela 01/01/1900 y fechas inválidas.
-- to_date LANZA error con "31/02/2026": se captura para que una fecha imposible
-- rechace su fila (fecha_*_invalida) en vez de abortar todo el lote.
CREATE FUNCTION fn_import_fecha(p text)
RETURNS date LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v date;
BEGIN
    IF p IS NULL OR p !~ '^\d{2}/\d{2}/\d{4}$' OR p = '01/01/1900' THEN
        RETURN NULL;
    END IF;
    BEGIN
        v := to_date(p, 'DD/MM/YYYY');
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
        RETURN NULL;
    END;
    RETURN CASE WHEN to_char(v, 'DD/MM/YYYY') = p THEN v END;
END;
$$;

CREATE FUNCTION fn_import_fecha_valida(p text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
    SELECT p = '01/01/1900' OR fn_import_fecha(p) IS NOT NULL;
$$;

CREATE FUNCTION fn_import_corregir_mojibake(p text)
RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
    r record;
BEGIN
    IF p IS NULL OR position('Ã' IN p) = 0 THEN
        RETURN p;
    END IF;
    FOR r IN SELECT roto, correcto FROM import_map_mojibake LOOP
        p := replace(p, r.roto, r.correcto);
    END LOOP;
    RETURN p;
END;
$$;

CREATE FUNCTION fn_import_carrera_sin_modalidad(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT fn_import_limpiar(regexp_replace(
        p, '\s*\(\s*(semi\s*-?\s*presencial|presencial|virtual)\s*\)', '', 'gi'));
$$;

-- Excel con fin < inicio: se suman años al fin hasta alcanzar el inicio.
CREATE FUNCTION fn_import_ajustar_fin(p_inicio date, p_fin date)
RETURNS date LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v date := p_fin;
BEGIN
    IF p_inicio IS NULL OR v IS NULL THEN
        RETURN v;
    END IF;
    WHILE v < p_inicio LOOP
        v := (v + interval '1 year')::date;
    END LOOP;
    RETURN v;
END;
$$;

CREATE FUNCTION fn_import_inicio_dia(p date)
RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$
    SELECT (p::timestamp AT TIME ZONE 'America/El_Salvador');
$$;

-- -----------------------------------------------------------------------------
-- 6. updated_at del lote (mismo trigger genérico del esquema 001)
-- -----------------------------------------------------------------------------
CREATE TRIGGER trg_import_batches_updated_at
    BEFORE UPDATE ON import_batches
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
