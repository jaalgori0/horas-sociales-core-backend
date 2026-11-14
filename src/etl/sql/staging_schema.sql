-- =============================================================================
-- Esquema `staging`: zona de aterrizaje en bruto para el ETL histórico.
--
-- NO es una migración del esquema maestro y NO pasa por `pnpm db:migrate`:
--   • Es desechable: `pnpm etl:staging:init` lo BORRA y lo vuelve a crear.
--   • Se elimina tras el corte definitivo con `pnpm etl:staging:drop`.
--
-- Reglas de diseño:
--   • Las columnas de DATOS son `text` tal como salen del archivo (solo trim).
--     Fechas "01/01/1900", horas, carnets, etc. se interpretan en la fase SQL.
--   • Sin FKs ni CHECKs sobre los datos: aquí entra todo lo que el archivo trae.
--   • Las columnas de PROCEDENCIA (archivo, página, línea/fila) sí van tipadas:
--     son generadas por el extractor y permiten rastrear cada dato a su origen.
--   • No hay DUI en las fuentes. Si alguna vez llega, debe entrar ya como
--     hash/cifrado (core/security/crypto.ts): nunca en claro en este esquema.
-- =============================================================================

DROP SCHEMA IF EXISTS staging CASCADE;
CREATE SCHEMA staging;
COMMENT ON SCHEMA staging IS 'ETL histórico: datos en bruto, desechable. Ver src/etl/sql/staging_schema.sql';

-- -----------------------------------------------------------------------------
-- Archivos procesados en la última carga.
-- -----------------------------------------------------------------------------
CREATE TABLE staging.source_files (
    archivo          text        NOT NULL,
    tipo             text        NOT NULL,            -- 'PDF_DETALLE_HORAS' | 'XLS_MEMORIA_LABORES'
    sha256           text        NOT NULL,            -- huella del archivo exacto que se cargó
    paginas          integer,                         -- PDF: páginas; XLS: null
    titulo           text,                            -- "Detalle de Horas por Proyecto", ...
    periodo_desde    text,                            -- PDF: "PERIODO DEL x AL y"
    periodo_hasta    text,
    generado_en      text,                            -- pie de página: "03/11/2026 9.49 AM"
    cargado_en       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_stg_source_files PRIMARY KEY (archivo)
);

-- -----------------------------------------------------------------------------
-- PDFs "Detalle de Horas por Proyecto": una fila por estudiante y proyecto.
-- -----------------------------------------------------------------------------
CREATE TABLE staging.pdf_hour_rows (
    id                  bigint      GENERATED ALWAYS AS IDENTITY,
    archivo             text        NOT NULL,
    pagina              integer     NOT NULL,
    linea               integer     NOT NULL,         -- línea visual (1..n) dentro de la página
    -- Contexto del bloque. El correlativo NO es único ni dentro de un archivo (dos
    -- proyectos "1" de instituciones distintas pueden ir seguidos): el proyecto es
    -- (cod_institucion, correlativo) y `bloque` enlaza la fila con su total impreso.
    bloque              integer,                      -- ordinal del bloque "PROYECTO:" en el archivo
    proyecto_nombre     text,
    correlativo         text,
    -- Columnas del reporte
    carnet              text,
    nombre_completo     text,                         -- "APELLIDO1, APELLIDO2 NOMBRES" (sin separar)
    fecha_inicio        text,
    fecha_fin           text,                         -- "01/01/1900" = sin fecha de fin
    cod_institucion     text,
    institucion         text,
    carrera             text,
    horas_asignadas     text,
    estado              text,
    -- Auditoría de extracción
    texto_original      text        NOT NULL,         -- líneas visuales unidas con " | "
    advertencias        text[]      NOT NULL DEFAULT '{}',
    CONSTRAINT pk_stg_pdf_hour_rows PRIMARY KEY (id),
    CONSTRAINT uq_stg_pdf_hour_rows_origen UNIQUE (archivo, pagina, linea)
);

-- -----------------------------------------------------------------------------
-- Excel "Memoria de Labores del CSS": una fila por proyecto.
-- -----------------------------------------------------------------------------
CREATE TABLE staging.xls_project_rows (
    id                  bigint      GENERATED ALWAYS AS IDENTITY,
    archivo             text        NOT NULL,
    hoja                text        NOT NULL,
    fila_excel          integer     NOT NULL,         -- número de fila como se ve en Excel (1-based)
    area                text,                         -- sección: "EDUCACION", "PSICOLOGIA", ...
    cod_institucion     text,
    institucion         text,                         -- puede traer mojibake: "ESPAÃ?A"
    correlativo         text,
    proyecto_nombre     text,
    alumnos             text,
    fecha_inicio        text,
    fecha_fin           text,                         -- "01/01/1900" = sin fecha de fin
    advertencias        text[]      NOT NULL DEFAULT '{}',
    CONSTRAINT pk_stg_xls_project_rows PRIMARY KEY (id),
    CONSTRAINT uq_stg_xls_project_rows_origen UNIQUE (archivo, hoja, fila_excel)
);

-- -----------------------------------------------------------------------------
-- Totales de control impresos en los reportes, para conciliar en SQL
-- (p. ej. SUM(horas) por correlativo = TOTAL DE HORAS ASIGNADAS POR PROYECTO).
-- -----------------------------------------------------------------------------
CREATE TABLE staging.control_totals (
    id           bigint  GENERATED ALWAYS AS IDENTITY,
    archivo      text    NOT NULL,
    ubicacion    text    NOT NULL,                    -- "p3" (PDF) | "f531" (fila de Excel)
    alcance      text    NOT NULL,                    -- 'PROYECTO' | 'AREA' | 'ARCHIVO'
    bloque       integer,                             -- PDF/PROYECTO: = pdf_hour_rows.bloque
    clave        text,                                -- correlativo o área; null si alcance = ARCHIVO
    metrica      text    NOT NULL,                    -- 'HORAS' | 'ALUMNOS' | 'PROYECTOS'
    valor        text,
    CONSTRAINT pk_stg_control_totals PRIMARY KEY (id)
);

-- -----------------------------------------------------------------------------
-- Líneas que el extractor no supo clasificar. Nada se descarta en silencio:
-- si esta tabla tiene filas, hay que revisarlas antes de transformar.
-- -----------------------------------------------------------------------------
CREATE TABLE staging.unparsed_lines (
    id          bigint  GENERATED ALWAYS AS IDENTITY,
    archivo     text    NOT NULL,
    ubicacion   text    NOT NULL,
    texto       text    NOT NULL,
    motivo      text    NOT NULL,
    CONSTRAINT pk_stg_unparsed_lines PRIMARY KEY (id)
);
