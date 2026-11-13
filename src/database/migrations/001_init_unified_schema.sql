-- =============================================================================
-- 001_init_unified_schema.sql
-- Esquema maestro unificado: Horas Sociales UCA + Aplicativo de Citas
-- PostgreSQL >= 13
--
-- Unifica tres modelos previos en una sola base normalizada:
--   (A) applicativo-citas ........ estudiantes, carreras, proyectos, citas,
--                                  cita_eventos, correos, dias_bloqueados,
--                                  proyecto_campos, auditoria
--   (B) DER núcleo propuesto ..... facultad, carrera, estudiante, departamento,
--                                  municipio, distrito, institución, proyecto,
--                                  participación, movimiento_horas, administrador
--   (C) Portal / mapa ............ institutions, projects, project_enrollments,
--                                  students, users, faculties, careers, map_markers
--
-- Convenciones:
--   * PK uuid (gen_random_uuid) salvo `auditoria` (bigint identity, alto volumen)
--     y `dias_bloqueados` (PK natural = fecha).
--   * snake_case; timestamps `created_at` / `updated_at` (timestamptz) mantenidos
--     por trigger; nombres de restricciones explícitos: pk_, fk_, uq_, ck_, ix_.
--   * Enumeraciones como `text + CHECK` (fáciles de extender con una migración
--     y compatibles con Sequelize sin tipos ENUM nativos).
--
-- Este archivo es ejecutado:
--   1) por Docker en el primer arranque (/docker-entrypoint-initdb.d), o
--   2) por `pnpm db:migrate` dentro de una transacción.
-- En ambos casos queda registrado en `schema_migrations`.
--
-- ⚠ NO EDITAR una vez aplicado en un entorno compartido: cree 002_*.sql.
-- =============================================================================

SET client_min_messages = warning;

-- -----------------------------------------------------------------------------
-- 0. Extensiones
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS citext;    -- correos sin distinción de mayúsculas

-- -----------------------------------------------------------------------------
-- 1. Control de migraciones
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
    name        text        NOT NULL,
    checksum    char(64),                      -- sha256 del archivo; NULL = registrado por Docker init
    applied_at  timestamptz NOT NULL DEFAULT now(),
    applied_by  text        NOT NULL DEFAULT current_user,
    CONSTRAINT pk_schema_migrations PRIMARY KEY (name)
);

-- -----------------------------------------------------------------------------
-- 2. Funciones utilitarias
-- -----------------------------------------------------------------------------

-- Mantiene updated_at en cada UPDATE.
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

-- Normaliza texto para unicidad: minúsculas, sin tildes, espacios colapsados.
-- IMMUTABLE para poder usarse en columnas generadas e índices.
CREATE OR REPLACE FUNCTION fn_normalize_text(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$
    SELECT lower(
        regexp_replace(
            btrim(translate(p_value, 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun')),
            '\s+', ' ', 'g'
        )
    );
$$;

-- Actor de la operación: la aplicación puede fijarlo por transacción con
--   SET LOCAL app.actor = 'admin:<uuid>';
CREATE OR REPLACE FUNCTION fn_current_actor()
RETURNS text
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(NULLIF(current_setting('app.actor', true), ''), current_user::text);
$$;

-- -----------------------------------------------------------------------------
-- 3. Catálogo geográfico (El Salvador: departamento > municipio > distrito)
-- -----------------------------------------------------------------------------
CREATE TABLE geo_departments (
    id          uuid        NOT NULL DEFAULT gen_random_uuid(),
    codigo      text        NOT NULL,
    nombre      text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_geo_departments PRIMARY KEY (id),
    CONSTRAINT uq_geo_departments_codigo UNIQUE (codigo),
    CONSTRAINT uq_geo_departments_nombre UNIQUE (nombre),
    CONSTRAINT ck_geo_departments_codigo CHECK (btrim(codigo) <> ''),
    CONSTRAINT ck_geo_departments_nombre CHECK (btrim(nombre) <> '')
);

CREATE TABLE geo_municipalities (
    id             uuid        NOT NULL DEFAULT gen_random_uuid(),
    department_id  uuid        NOT NULL,
    codigo         text        NOT NULL,
    nombre         text        NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_geo_municipalities PRIMARY KEY (id),
    CONSTRAINT fk_geo_municipalities_department FOREIGN KEY (department_id)
        REFERENCES geo_departments (id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT uq_geo_municipalities_codigo UNIQUE (department_id, codigo),
    CONSTRAINT uq_geo_municipalities_nombre UNIQUE (department_id, nombre),
    CONSTRAINT ck_geo_municipalities_nombre CHECK (btrim(nombre) <> '')
);
CREATE INDEX ix_geo_municipalities_department ON geo_municipalities (department_id);

CREATE TABLE geo_districts (
    id               uuid        NOT NULL DEFAULT gen_random_uuid(),
    municipality_id  uuid        NOT NULL,
    codigo           text        NOT NULL,
    nombre           text        NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_geo_districts PRIMARY KEY (id),
    CONSTRAINT fk_geo_districts_municipality FOREIGN KEY (municipality_id)
        REFERENCES geo_municipalities (id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT uq_geo_districts_codigo UNIQUE (municipality_id, codigo),
    CONSTRAINT uq_geo_districts_nombre UNIQUE (municipality_id, nombre),
    CONSTRAINT ck_geo_districts_nombre CHECK (btrim(nombre) <> '')
);
CREATE INDEX ix_geo_districts_municipality ON geo_districts (municipality_id);

-- -----------------------------------------------------------------------------
-- 4. Estructura académica
-- -----------------------------------------------------------------------------
CREATE TABLE faculties (
    id                  uuid        NOT NULL DEFAULT gen_random_uuid(),
    nombre              text        NOT NULL,
    nombre_normalizado  text        GENERATED ALWAYS AS (fn_normalize_text(nombre)) STORED,
    activo              boolean     NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_faculties PRIMARY KEY (id),
    CONSTRAINT uq_faculties_nombre UNIQUE (nombre_normalizado),
    CONSTRAINT ck_faculties_nombre CHECK (btrim(nombre) <> '')
);

CREATE TABLE careers (
    id                  uuid        NOT NULL DEFAULT gen_random_uuid(),
    faculty_id          uuid        NOT NULL,
    nombre              text        NOT NULL,
    nombre_normalizado  text        GENERATED ALWAYS AS (fn_normalize_text(nombre)) STORED,
    activo              boolean     NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_careers PRIMARY KEY (id),
    -- RESTRICT: una facultad con carreras no se borra; se desactiva.
    CONSTRAINT fk_careers_faculty FOREIGN KEY (faculty_id)
        REFERENCES faculties (id) ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT uq_careers_nombre UNIQUE (nombre_normalizado),
    CONSTRAINT ck_careers_nombre CHECK (btrim(nombre) <> '')
);
CREATE INDEX ix_careers_faculty ON careers (faculty_id);

-- -----------------------------------------------------------------------------
-- 5. Usuarios administrativos (antes: users / administrador)
-- -----------------------------------------------------------------------------
CREATE TABLE users (
    id                uuid        NOT NULL DEFAULT gen_random_uuid(),
    nombres           text        NOT NULL,
    apellidos         text        NOT NULL,
    correo            citext      NOT NULL,
    password_hash     text        NOT NULL,
    rol               text        NOT NULL DEFAULT 'ADMIN',
    activo            boolean     NOT NULL DEFAULT true,
    ultimo_acceso_en  timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_users PRIMARY KEY (id),
    CONSTRAINT uq_users_correo UNIQUE (correo),
    CONSTRAINT ck_users_correo CHECK (correo ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    CONSTRAINT ck_users_rol CHECK (rol IN ('ADMIN', 'COORDINADOR', 'CONSULTA')),
    CONSTRAINT ck_users_password_hash CHECK (length(password_hash) >= 20)
);

-- -----------------------------------------------------------------------------
-- 6. Estudiantes (fusión de ESTUDIANTES + ESTUDIANTE + students)
-- -----------------------------------------------------------------------------
CREATE TABLE students (
    id                    uuid        NOT NULL DEFAULT gen_random_uuid(),
    carnet                text        NOT NULL,
    nombres               text        NOT NULL,
    apellidos             text        NOT NULL,
    nombre_completo       text        GENERATED ALWAYS AS (nombres || ' ' || apellidos) STORED,
    correo_institucional  citext      NOT NULL,
    email_personal        citext,
    telefono              text,
    genero                text,
    avatar_url            text,
    career_id             uuid        NOT NULL,
    -- DUI: HMAC-SHA256 (búsqueda/unicidad) + AES-256-GCM (recuperación). Nunca en claro.
    dui_hash              bytea,
    dui_cifrado           bytea,
    activo                boolean     NOT NULL DEFAULT true,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_students PRIMARY KEY (id),
    -- RESTRICT: no se puede borrar una carrera con estudiantes.
    CONSTRAINT fk_students_career FOREIGN KEY (career_id)
        REFERENCES careers (id) ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT uq_students_carnet UNIQUE (carnet),
    CONSTRAINT uq_students_correo_institucional UNIQUE (correo_institucional),
    CONSTRAINT uq_students_dui_hash UNIQUE (dui_hash),
    CONSTRAINT ck_students_carnet CHECK (carnet ~ '^[0-9]{8}$'),
    CONSTRAINT ck_students_nombres CHECK (btrim(nombres) <> '' AND btrim(apellidos) <> ''),
    CONSTRAINT ck_students_correo_institucional CHECK (correo_institucional ~* '^[^@\s]+@uca\.edu\.sv$'),
    CONSTRAINT ck_students_email_personal CHECK (email_personal IS NULL OR email_personal ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    CONSTRAINT ck_students_telefono CHECK (telefono IS NULL OR telefono ~ '^[0-9+\-\s]{8,20}$'),
    CONSTRAINT ck_students_genero CHECK (genero IS NULL OR genero IN ('HOMBRE', 'MUJER')),
    CONSTRAINT ck_students_dui_par CHECK ((dui_hash IS NULL) = (dui_cifrado IS NULL)),
    CONSTRAINT ck_students_dui_hash_len CHECK (dui_hash IS NULL OR octet_length(dui_hash) = 32)
);
CREATE INDEX ix_students_career ON students (career_id);
CREATE INDEX ix_students_nombre_completo ON students (lower(nombre_completo));

-- -----------------------------------------------------------------------------
-- 7. Instituciones y proyectos
-- -----------------------------------------------------------------------------
CREATE TABLE institutions (
    id                  uuid        NOT NULL DEFAULT gen_random_uuid(),
    nombre              text        NOT NULL,
    nombre_normalizado  text        GENERATED ALWAYS AS (fn_normalize_text(nombre)) STORED,
    sigla               text,
    tipo                text,
    descripcion         text,
    ubicacion           text,
    direccion           text,
    district_id         uuid,                    -- sede
    image_url           text,
    estadisticas        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    activo              boolean     NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_institutions PRIMARY KEY (id),
    CONSTRAINT fk_institutions_district FOREIGN KEY (district_id)
        REFERENCES geo_districts (id) ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT uq_institutions_nombre UNIQUE (nombre_normalizado),
    CONSTRAINT ck_institutions_nombre CHECK (btrim(nombre) <> ''),
    CONSTRAINT ck_institutions_tipo CHECK (tipo IS NULL OR tipo IN
        ('GUBERNAMENTAL', 'MUNICIPAL', 'ONG', 'PRIVADA', 'ACADEMICA', 'COMUNITARIA', 'RELIGIOSA', 'INTERNACIONAL', 'OTRA')),
    CONSTRAINT ck_institutions_estadisticas CHECK (jsonb_typeof(estadisticas) = 'object')
);
CREATE INDEX ix_institutions_district ON institutions (district_id);

-- Definición dinámica de atributos de proyecto (antes PROYECTO_CAMPOS).
-- projects.atributos (jsonb) se valida en la aplicación contra estas claves.
CREATE TABLE project_fields (
    clave       text        NOT NULL,
    etiqueta    text        NOT NULL,
    tipo        text        NOT NULL,
    requerido   boolean     NOT NULL DEFAULT false,
    opciones    jsonb       NOT NULL DEFAULT '[]'::jsonb,
    orden       smallint    NOT NULL DEFAULT 0,
    activo      boolean     NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_project_fields PRIMARY KEY (clave),
    CONSTRAINT ck_project_fields_clave CHECK (clave ~ '^[a-z][a-z0-9_]{1,62}$'),
    CONSTRAINT ck_project_fields_tipo CHECK (tipo IN
        ('TEXTO', 'TEXTO_LARGO', 'NUMERO', 'FECHA', 'BOOLEANO', 'SELECCION', 'MULTISELECCION')),
    CONSTRAINT ck_project_fields_opciones CHECK (
        jsonb_typeof(opciones) = 'array'
        AND (tipo NOT IN ('SELECCION', 'MULTISELECCION') OR jsonb_array_length(opciones) > 0)
    )
);

CREATE TABLE projects (
    id                     uuid        NOT NULL DEFAULT gen_random_uuid(),
    institution_id         uuid        NOT NULL,
    faculty_id             uuid,                 -- facultad responsable
    district_id            uuid,                 -- lugar de ejecución (≠ sede de la institución)
    titulo                 text        NOT NULL,
    nombre_normalizado     text        GENERATED ALWAYS AS (fn_normalize_text(titulo)) STORED,
    descripcion            text        NOT NULL,
    resumen                text,
    ubicacion              text,
    naturaleza             text        NOT NULL DEFAULT 'EXTERNA',
    estado                 text        NOT NULL DEFAULT 'ACTIVO',
    fecha_inicio           date,
    fecha_cierre           date,
    cupos                  integer,              -- alumnos solicitados
    personas_beneficiadas  integer     NOT NULL DEFAULT 0,
    image_url              text,
    atributos              jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_projects PRIMARY KEY (id),
    -- RESTRICT: una institución con proyectos (y su historial de horas) no se borra.
    CONSTRAINT fk_projects_institution FOREIGN KEY (institution_id)
        REFERENCES institutions (id) ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_projects_faculty FOREIGN KEY (faculty_id)
        REFERENCES faculties (id) ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT fk_projects_district FOREIGN KEY (district_id)
        REFERENCES geo_districts (id) ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT uq_projects_institution_nombre UNIQUE (institution_id, nombre_normalizado),
    CONSTRAINT ck_projects_titulo CHECK (btrim(titulo) <> ''),
    CONSTRAINT ck_projects_naturaleza CHECK (naturaleza IN ('INTERNA', 'EXTERNA')),
    CONSTRAINT ck_projects_estado CHECK (estado IN ('BORRADOR', 'ACTIVO', 'PAUSADO', 'FINALIZADO', 'CANCELADO')),
    CONSTRAINT ck_projects_fechas CHECK (fecha_cierre IS NULL OR fecha_inicio IS NULL OR fecha_cierre >= fecha_inicio),
    CONSTRAINT ck_projects_cupos CHECK (cupos IS NULL OR cupos > 0),
    CONSTRAINT ck_projects_personas CHECK (personas_beneficiadas >= 0),
    CONSTRAINT ck_projects_atributos CHECK (jsonb_typeof(atributos) = 'object')
);
CREATE INDEX ix_projects_institution ON projects (institution_id);
CREATE INDEX ix_projects_faculty ON projects (faculty_id);
CREATE INDEX ix_projects_district ON projects (district_id);
CREATE INDEX ix_projects_estado ON projects (estado);

-- Carreras a las que va dirigido un proyecto (antes projects.carreras text[]).
CREATE TABLE project_careers (
    project_id  uuid        NOT NULL,
    career_id   uuid        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_project_careers PRIMARY KEY (project_id, career_id),
    CONSTRAINT fk_project_careers_project FOREIGN KEY (project_id)
        REFERENCES projects (id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_project_careers_career FOREIGN KEY (career_id)
        REFERENCES careers (id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX ix_project_careers_career ON project_careers (career_id);

-- Equipo responsable del proyecto (antes projects.team_members text[]).
CREATE TABLE project_team_members (
    id          uuid        NOT NULL DEFAULT gen_random_uuid(),
    project_id  uuid        NOT NULL,
    nombre      text        NOT NULL,
    rol         text,
    correo      citext,
    orden       smallint    NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_project_team_members PRIMARY KEY (id),
    CONSTRAINT fk_project_team_members_project FOREIGN KEY (project_id)
        REFERENCES projects (id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT ck_project_team_members_nombre CHECK (btrim(nombre) <> '')
);
CREATE INDEX ix_project_team_members_project ON project_team_members (project_id);

-- Marcadores del mapa de impacto (antes map_markers).
CREATE TABLE map_markers (
    id           uuid          NOT NULL DEFAULT gen_random_uuid(),
    project_id   uuid          NOT NULL,
    district_id  uuid,
    label        text          NOT NULL,
    hombres      integer       NOT NULL DEFAULT 0,
    mujeres      integer       NOT NULL DEFAULT 0,
    lat          numeric(9, 6) NOT NULL,
    lng          numeric(9, 6) NOT NULL,
    created_at   timestamptz   NOT NULL DEFAULT now(),
    updated_at   timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT pk_map_markers PRIMARY KEY (id),
    CONSTRAINT fk_map_markers_project FOREIGN KEY (project_id)
        REFERENCES projects (id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_map_markers_district FOREIGN KEY (district_id)
        REFERENCES geo_districts (id) ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT ck_map_markers_label CHECK (btrim(label) <> ''),
    CONSTRAINT ck_map_markers_conteos CHECK (hombres >= 0 AND mujeres >= 0),
    CONSTRAINT ck_map_markers_lat CHECK (lat BETWEEN -90 AND 90),
    CONSTRAINT ck_map_markers_lng CHECK (lng BETWEEN -180 AND 180)
);
CREATE INDEX ix_map_markers_project ON map_markers (project_id);
CREATE INDEX ix_map_markers_district ON map_markers (district_id);

-- -----------------------------------------------------------------------------
-- 8. Participación y horas sociales
-- -----------------------------------------------------------------------------
CREATE TABLE project_enrollments (
    id           uuid        NOT NULL DEFAULT gen_random_uuid(),
    project_id   uuid        NOT NULL,
    student_id   uuid        NOT NULL,
    cargo        text        NOT NULL DEFAULT 'ESTUDIANTE',
    estado       text        NOT NULL DEFAULT 'ASIGNADA',
    asignada_en  timestamptz NOT NULL DEFAULT now(),
    cerrada_en   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_project_enrollments PRIMARY KEY (id),
    -- RESTRICT en ambos lados: una participación con horas es historial académico.
    CONSTRAINT fk_project_enrollments_project FOREIGN KEY (project_id)
        REFERENCES projects (id) ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_project_enrollments_student FOREIGN KEY (student_id)
        REFERENCES students (id) ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT uq_project_enrollments_student_project UNIQUE (student_id, project_id),
    CONSTRAINT ck_project_enrollments_cargo CHECK (btrim(cargo) <> ''),
    CONSTRAINT ck_project_enrollments_estado CHECK (estado IN
        ('ASIGNADA', 'EN_CURSO', 'FINALIZADA', 'RETIRADA', 'CANCELADA')),
    CONSTRAINT ck_project_enrollments_cierre CHECK (
        (estado IN ('FINALIZADA', 'RETIRADA', 'CANCELADA')) = (cerrada_en IS NOT NULL)
    ),
    CONSTRAINT ck_project_enrollments_fechas CHECK (cerrada_en IS NULL OR cerrada_en >= asignada_en)
);
CREATE INDEX ix_project_enrollments_project ON project_enrollments (project_id);
CREATE INDEX ix_project_enrollments_estado ON project_enrollments (estado);

-- Libro mayor de horas (antes MOVIMIENTO_HORAS).
CREATE TABLE hour_movements (
    id              uuid        NOT NULL DEFAULT gen_random_uuid(),
    enrollment_id   uuid        NOT NULL,
    horas           integer     NOT NULL,
    naturaleza      text        NOT NULL,
    fecha_horas     date        NOT NULL,
    descripcion     text,
    registrado_por  uuid,
    registrado_en   timestamptz NOT NULL DEFAULT now(),
    solicitud_id    uuid,                         -- idempotencia de registro
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_hour_movements PRIMARY KEY (id),
    CONSTRAINT fk_hour_movements_enrollment FOREIGN KEY (enrollment_id)
        REFERENCES project_enrollments (id) ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_hour_movements_registrado_por FOREIGN KEY (registrado_por)
        REFERENCES users (id) ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT uq_hour_movements_solicitud UNIQUE (solicitud_id),
    CONSTRAINT ck_hour_movements_horas CHECK (horas > 0),
    CONSTRAINT ck_hour_movements_naturaleza CHECK (naturaleza IN ('INTERNA', 'EXTERNA'))
);
CREATE INDEX ix_hour_movements_enrollment ON hour_movements (enrollment_id);
CREATE INDEX ix_hour_movements_registrado_por ON hour_movements (registrado_por);
CREATE INDEX ix_hour_movements_fecha ON hour_movements (fecha_horas);

-- -----------------------------------------------------------------------------
-- 9. Citas
-- -----------------------------------------------------------------------------
CREATE TABLE dias_bloqueados (
    fecha       date        NOT NULL,
    bloqueado   boolean     NOT NULL DEFAULT true,
    motivo      text,
    creado_por  uuid,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_dias_bloqueados PRIMARY KEY (fecha),
    CONSTRAINT fk_dias_bloqueados_creado_por FOREIGN KEY (creado_por)
        REFERENCES users (id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE SEQUENCE citas_codigo_seq AS bigint START WITH 1;

CREATE TABLE citas (
    id                     uuid        NOT NULL DEFAULT gen_random_uuid(),
    codigo                 text        NOT NULL DEFAULT (
        'CITA-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('citas_codigo_seq')::text, 6, '0')
    ),
    student_id             uuid        NOT NULL,
    career_id              uuid,                 -- carrera del estudiante al momento de la cita
    project_id             uuid,                 -- proyecto del catálogo (si existe)
    enrollment_id          uuid,                 -- participación generada por la cita
    ciclo_egreso           text,
    -- Instantánea textual: conserva el historial aunque el proyecto se elimine
    -- o cuando el estudiante propone un proyecto que aún no está en catálogo.
    proyecto_nombre        text,
    institucion_nombre     text,
    origen                 text        NOT NULL DEFAULT 'PORTAL_ESTUDIANTE',
    estado                 text        NOT NULL DEFAULT 'SOLICITADA',
    asistencia             text        NOT NULL DEFAULT 'PENDIENTE',
    fecha_hora_tentativa   timestamptz NOT NULL,
    fecha_hora             timestamptz,          -- fecha confirmada por la unidad
    comentario_estudiante  text,
    observacion_admin      text,
    atendido_por           uuid,
    clave_idempotencia     uuid,
    cancelado_en           timestamptz,
    motivo_cancelacion     text,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_citas PRIMARY KEY (id),
    CONSTRAINT fk_citas_student FOREIGN KEY (student_id)
        REFERENCES students (id) ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_citas_career FOREIGN KEY (career_id)
        REFERENCES careers (id) ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT fk_citas_project FOREIGN KEY (project_id)
        REFERENCES projects (id) ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT fk_citas_enrollment FOREIGN KEY (enrollment_id)
        REFERENCES project_enrollments (id) ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT fk_citas_atendido_por FOREIGN KEY (atendido_por)
        REFERENCES users (id) ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT uq_citas_codigo UNIQUE (codigo),
    CONSTRAINT uq_citas_clave_idempotencia UNIQUE (clave_idempotencia),
    CONSTRAINT ck_citas_ciclo_egreso CHECK (ciclo_egreso IS NULL OR ciclo_egreso ~ '^0[1-3]-[0-9]{4}$'),
    CONSTRAINT ck_citas_proyecto CHECK (project_id IS NOT NULL OR btrim(coalesce(proyecto_nombre, '')) <> ''),
    CONSTRAINT ck_citas_origen CHECK (origen IN ('PORTAL_ESTUDIANTE', 'ADMINISTRADOR')),
    CONSTRAINT ck_citas_estado CHECK (estado IN
        ('SOLICITADA', 'CONFIRMADA', 'REPROGRAMADA', 'FINALIZADA', 'CANCELADA')),
    CONSTRAINT ck_citas_asistencia CHECK (asistencia IN ('PENDIENTE', 'ASISTIO', 'NO_ASISTIO')),
    -- La asistencia solo se registra al finalizar la cita.
    CONSTRAINT ck_citas_asistencia_estado CHECK ((estado = 'FINALIZADA') = (asistencia <> 'PENDIENTE')),
    -- Una cita confirmada/reprogramada/finalizada necesita fecha definitiva.
    CONSTRAINT ck_citas_fecha_confirmada CHECK (
        estado NOT IN ('CONFIRMADA', 'REPROGRAMADA', 'FINALIZADA') OR fecha_hora IS NOT NULL
    ),
    CONSTRAINT ck_citas_cancelacion CHECK ((estado = 'CANCELADA') = (cancelado_en IS NOT NULL))
);
ALTER SEQUENCE citas_codigo_seq OWNED BY citas.codigo;

CREATE INDEX ix_citas_student ON citas (student_id);
CREATE INDEX ix_citas_career ON citas (career_id);
CREATE INDEX ix_citas_project ON citas (project_id);
CREATE INDEX ix_citas_enrollment ON citas (enrollment_id);
CREATE INDEX ix_citas_atendido_por ON citas (atendido_por);
CREATE INDEX ix_citas_estado_fecha ON citas (estado, fecha_hora);
-- Un estudiante solo puede tener una cita abierta a la vez.
CREATE UNIQUE INDEX uq_citas_student_abierta ON citas (student_id)
    WHERE estado IN ('SOLICITADA', 'CONFIRMADA', 'REPROGRAMADA');

CREATE TABLE cita_eventos (
    id           uuid        NOT NULL DEFAULT gen_random_uuid(),
    cita_id      uuid        NOT NULL,
    tipo         text        NOT NULL,
    descripcion  text        NOT NULL,
    actor        text        NOT NULL DEFAULT fn_current_actor(),
    user_id      uuid,
    creado_en    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_cita_eventos PRIMARY KEY (id),
    CONSTRAINT fk_cita_eventos_cita FOREIGN KEY (cita_id)
        REFERENCES citas (id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_cita_eventos_user FOREIGN KEY (user_id)
        REFERENCES users (id) ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT ck_cita_eventos_tipo CHECK (tipo IN ('CREADA', 'CAMBIO_ESTADO', 'CAMBIO_FECHA', 'NOTA', 'CORREO'))
);
CREATE INDEX ix_cita_eventos_cita ON cita_eventos (cita_id, creado_en);
CREATE INDEX ix_cita_eventos_user ON cita_eventos (user_id);

-- Bandeja de salida de correos (patrón outbox).
CREATE TABLE correos (
    id            uuid        NOT NULL DEFAULT gen_random_uuid(),
    cita_id       uuid        NOT NULL,
    tipo          text        NOT NULL,
    destinatario  citext      NOT NULL,
    asunto        text        NOT NULL,
    estado        text        NOT NULL DEFAULT 'PENDIENTE',
    intentos      smallint    NOT NULL DEFAULT 0,
    ultimo_error  text,
    enviado_en    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_correos PRIMARY KEY (id),
    CONSTRAINT fk_correos_cita FOREIGN KEY (cita_id)
        REFERENCES citas (id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT ck_correos_tipo CHECK (tipo IN
        ('SOLICITUD_RECIBIDA', 'CONFIRMACION', 'REPROGRAMACION', 'CANCELACION', 'RECORDATORIO')),
    CONSTRAINT ck_correos_destinatario CHECK (destinatario ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    CONSTRAINT ck_correos_estado CHECK (estado IN ('PENDIENTE', 'ENVIADO', 'FALLIDO')),
    CONSTRAINT ck_correos_intentos CHECK (intentos BETWEEN 0 AND 20),
    CONSTRAINT ck_correos_enviado CHECK ((estado = 'ENVIADO') = (enviado_en IS NOT NULL))
);
CREATE INDEX ix_correos_cita ON correos (cita_id);
CREATE INDEX ix_correos_pendientes ON correos (created_at) WHERE estado = 'PENDIENTE';

-- -----------------------------------------------------------------------------
-- 10. Auditoría
-- -----------------------------------------------------------------------------
CREATE TABLE auditoria (
    id             bigint      GENERATED ALWAYS AS IDENTITY,
    tabla          text        NOT NULL,
    registro_id    text        NOT NULL,
    operacion      text        NOT NULL,
    datos_antes    jsonb,
    datos_despues  jsonb,
    actor          text        NOT NULL,
    ocurrido_en    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_auditoria PRIMARY KEY (id),
    CONSTRAINT ck_auditoria_operacion CHECK (operacion IN ('INSERT', 'UPDATE', 'DELETE'))
);
CREATE INDEX ix_auditoria_registro ON auditoria (tabla, registro_id);
CREATE INDEX ix_auditoria_ocurrido_en ON auditoria (ocurrido_en);

-- Trigger genérico. TG_ARGV[0] = nombre de la columna PK (por defecto 'id').
-- Los campos sensibles nunca se copian a la auditoría.
CREATE OR REPLACE FUNCTION fn_auditoria()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_pk      text  := COALESCE(TG_ARGV[0], 'id');
    v_old     jsonb;
    v_new     jsonb;
    v_secret  text[] := ARRAY['dui_hash', 'dui_cifrado', 'password_hash'];
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        v_old := to_jsonb(OLD) - v_secret;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        v_new := to_jsonb(NEW) - v_secret;
    END IF;

    -- Omitir UPDATE sin cambios reales (solo updated_at).
    IF TG_OP = 'UPDATE' AND (v_old - 'updated_at') = (v_new - 'updated_at') THEN
        RETURN NEW;
    END IF;

    INSERT INTO auditoria (tabla, registro_id, operacion, datos_antes, datos_despues, actor)
    VALUES (
        TG_TABLE_NAME,
        COALESCE(v_new ->> v_pk, v_old ->> v_pk),
        TG_OP,
        v_old,
        v_new,
        fn_current_actor()
    );

    RETURN COALESCE(NEW, OLD);
END;
$$;

-- -----------------------------------------------------------------------------
-- 11. Reglas de negocio de citas (triggers)
-- -----------------------------------------------------------------------------

-- Impide agendar citas activas en días bloqueados (hora local de El Salvador).
CREATE OR REPLACE FUNCTION fn_citas_validar_dia_bloqueado()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_fecha date;
BEGIN
    IF NEW.estado IN ('CANCELADA', 'FINALIZADA') THEN
        RETURN NEW;
    END IF;

    v_fecha := (COALESCE(NEW.fecha_hora, NEW.fecha_hora_tentativa) AT TIME ZONE 'America/El_Salvador')::date;

    IF EXISTS (SELECT 1 FROM dias_bloqueados WHERE fecha = v_fecha AND bloqueado) THEN
        RAISE EXCEPTION 'La fecha % está bloqueada para citas', v_fecha
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'ck_citas_dia_no_bloqueado',
                  TABLE = 'citas';
    END IF;

    RETURN NEW;
END;
$$;

-- Historial automático: creación, cambios de estado y de fecha.
CREATE OR REPLACE FUNCTION fn_citas_registrar_evento()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO cita_eventos (cita_id, tipo, descripcion)
        VALUES (NEW.id, 'CREADA', format('Cita %s creada en estado %s', NEW.codigo, NEW.estado));
    ELSE
        IF NEW.estado IS DISTINCT FROM OLD.estado THEN
            INSERT INTO cita_eventos (cita_id, tipo, descripcion)
            VALUES (NEW.id, 'CAMBIO_ESTADO', format('Estado: %s → %s', OLD.estado, NEW.estado));
        END IF;
        IF NEW.fecha_hora IS DISTINCT FROM OLD.fecha_hora THEN
            INSERT INTO cita_eventos (cita_id, tipo, descripcion)
            VALUES (NEW.id, 'CAMBIO_FECHA', format('Fecha: %s → %s',
                COALESCE(OLD.fecha_hora::text, 'sin definir'),
                COALESCE(NEW.fecha_hora::text, 'sin definir')));
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_citas_validar_dia_bloqueado
    BEFORE INSERT OR UPDATE OF fecha_hora, fecha_hora_tentativa, estado ON citas
    FOR EACH ROW EXECUTE FUNCTION fn_citas_validar_dia_bloqueado();

CREATE TRIGGER trg_citas_registrar_evento
    AFTER INSERT OR UPDATE OF estado, fecha_hora ON citas
    FOR EACH ROW EXECUTE FUNCTION fn_citas_registrar_evento();

-- -----------------------------------------------------------------------------
-- 12. Triggers updated_at y auditoría (asignación masiva)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_table text;
BEGIN
    -- updated_at en toda tabla que lo tenga
    FOREACH v_table IN ARRAY ARRAY[
        'geo_departments', 'geo_municipalities', 'geo_districts',
        'faculties', 'careers', 'users', 'students',
        'institutions', 'project_fields', 'projects', 'project_team_members', 'map_markers',
        'project_enrollments', 'hour_movements',
        'dias_bloqueados', 'citas', 'correos'
    ]
    LOOP
        EXECUTE format(
            'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$I
             FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at()', v_table);
    END LOOP;

    -- auditoría en tablas de negocio con PK `id`
    FOREACH v_table IN ARRAY ARRAY[
        'faculties', 'careers', 'users', 'students',
        'institutions', 'projects', 'project_enrollments', 'hour_movements', 'citas'
    ]
    LOOP
        EXECUTE format(
            'CREATE TRIGGER trg_%1$s_auditoria AFTER INSERT OR UPDATE OR DELETE ON %1$I
             FOR EACH ROW EXECUTE FUNCTION fn_auditoria(%2$L)', v_table, 'id');
    END LOOP;
END;
$$;

CREATE TRIGGER trg_project_fields_auditoria
    AFTER INSERT OR UPDATE OR DELETE ON project_fields
    FOR EACH ROW EXECUTE FUNCTION fn_auditoria('clave');

CREATE TRIGGER trg_dias_bloqueados_auditoria
    AFTER INSERT OR UPDATE OR DELETE ON dias_bloqueados
    FOR EACH ROW EXECUTE FUNCTION fn_auditoria('fecha');

-- -----------------------------------------------------------------------------
-- 13. Vistas de lectura
-- -----------------------------------------------------------------------------

-- Saldo de horas sociales por estudiante.
CREATE VIEW v_student_hours AS
SELECT
    s.id                                                                AS student_id,
    s.carnet,
    s.nombre_completo,
    COALESCE(SUM(hm.horas) FILTER (WHERE hm.naturaleza = 'INTERNA'), 0)::integer AS horas_internas,
    COALESCE(SUM(hm.horas) FILTER (WHERE hm.naturaleza = 'EXTERNA'), 0)::integer AS horas_externas,
    COALESCE(SUM(hm.horas), 0)::integer                                 AS horas_totales,
    COUNT(DISTINCT pe.id)::integer                                      AS participaciones
FROM students s
LEFT JOIN project_enrollments pe ON pe.student_id = s.id
LEFT JOIN hour_movements hm      ON hm.enrollment_id = pe.id
GROUP BY s.id;

-- -----------------------------------------------------------------------------
-- 14. Registro de esta migración
--     (el runner sobrescribe el checksum; Docker init lo deja en NULL y el
--      runner lo adopta en la siguiente ejecución de `pnpm db:migrate`)
-- -----------------------------------------------------------------------------
INSERT INTO schema_migrations (name, checksum, applied_by)
VALUES ('001_init_unified_schema.sql', NULL, 'sql-script')
ON CONFLICT (name) DO NOTHING;
