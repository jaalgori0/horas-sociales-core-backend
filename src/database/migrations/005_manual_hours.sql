-- =============================================================================
-- 005_manual_hours.sql
-- Descripción: asignación manual de horas desde el perfil del estudiante.
--
--   1. hour_movements.origen distingue lo que viene del CSS (IMPORTACION: ETL
--      histórico y POST /imports) de lo que registra un usuario (MANUAL).
--      La conciliación de importaciones (classify.sql) solo compara las horas
--      que NO son manuales: una corrección manual nunca genera "horas_difieren".
--   2. hour_movements.concepto: motivo obligatorio de toda asignación manual.
--   3. Proyecto interno del sistema "Asignaciones Manuales / Actividades Internas"
--      (institución UCA) para convalidaciones y actividades fuera de los
--      proyectos del CSS. Se identifica por atributos->>'sistema'. Ubicación:
--      campus UCA, "Antiguo Cuscatlán, La Libertad" (el mapa ubica a los
--      participantes por projects.ubicacion; sin ella aparecen "sin ubicación").
--   4. v_student_hours expone horas_manuales.
--
-- Auditoría: hour_movements y project_enrollments ya tienen trg_*_auditoria (001).
-- =============================================================================

SELECT set_config('app.actor', 'migracion:005_manual_hours', true);

-- -----------------------------------------------------------------------------
-- 1. Origen y concepto de cada movimiento
-- -----------------------------------------------------------------------------
-- Hasta esta migración el único escritor de hour_movements era la carga del CSS
-- (ETL y /imports, ambos con solicitud_id = md5('etl-css|...')): todo es IMPORTACION.
ALTER TABLE hour_movements ADD COLUMN origen text NOT NULL DEFAULT 'IMPORTACION';
-- Sin DEFAULT a partir de aquí: todo escritor nuevo debe declarar su origen.
ALTER TABLE hour_movements ALTER COLUMN origen DROP DEFAULT;
ALTER TABLE hour_movements ADD COLUMN concepto text;

ALTER TABLE hour_movements ADD CONSTRAINT ck_hour_movements_origen
    CHECK (origen IN ('IMPORTACION', 'MANUAL'));
ALTER TABLE hour_movements ADD CONSTRAINT ck_hour_movements_concepto
    CHECK (origen <> 'MANUAL' OR btrim(coalesce(concepto, '')) <> '');

CREATE INDEX ix_hour_movements_enrollment_origen ON hour_movements (enrollment_id, origen);

COMMENT ON COLUMN hour_movements.origen IS
    'IMPORTACION = carga del CSS (ETL/POST /imports); MANUAL = asignada por un usuario desde el perfil.';
COMMENT ON COLUMN hour_movements.concepto IS 'Motivo de la asignación manual (obligatorio si origen = MANUAL).';

-- -----------------------------------------------------------------------------
-- 2. Institución UCA y proyecto interno de asignaciones manuales
-- -----------------------------------------------------------------------------
INSERT INTO institutions (nombre, sigla, tipo, descripcion, ubicacion)
VALUES ('Universidad Centroamericana José Simeón Cañas', 'UCA', 'ACADEMICA',
        'Institución universitaria. Agrupa los proyectos internos de la unidad de proyección social.',
        'Antiguo Cuscatlán, La Libertad')
ON CONFLICT ON CONSTRAINT uq_institutions_nombre DO NOTHING;

-- Si la UCA ya existía sin ubicación, se completa (nunca se sobrescribe un valor existente).
UPDATE institutions
SET ubicacion = 'Antiguo Cuscatlán, La Libertad'
WHERE nombre_normalizado = fn_normalize_text('Universidad Centroamericana José Simeón Cañas')
  AND ubicacion IS NULL;

-- Un solo proyecto por clave de sistema.
CREATE UNIQUE INDEX uq_projects_sistema ON projects ((atributos ->> 'sistema'))
    WHERE atributos ? 'sistema';

INSERT INTO projects (institution_id, titulo, descripcion, resumen, ubicacion, naturaleza, estado, atributos)
SELECT i.id,
       'Asignaciones Manuales / Actividades Internas',
       'Proyecto interno del sistema para registrar horas sociales asignadas manualmente: '
       'convalidaciones, actividades internas y casos especiales fuera de los proyectos del CSS. '
       'Cada movimiento conserva su concepto y el usuario que lo registró.',
       'Horas asignadas manualmente (convalidaciones y actividades internas).',
       'Antiguo Cuscatlán, La Libertad',
       'INTERNA', 'ACTIVO',
       '{"sistema": "ASIGNACIONES_MANUALES"}'::jsonb
FROM institutions i
WHERE i.nombre_normalizado = fn_normalize_text('Universidad Centroamericana José Simeón Cañas')
ON CONFLICT DO NOTHING;

UPDATE projects
SET ubicacion = 'Antiguo Cuscatlán, La Libertad'
WHERE atributos ->> 'sistema' = 'ASIGNACIONES_MANUALES'
  AND ubicacion IS NULL;

-- -----------------------------------------------------------------------------
-- 3. Saldo por estudiante con desglose manual (columnas nuevas al final)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_student_hours AS
SELECT
    s.id                                                                AS student_id,
    s.carnet,
    s.nombre_completo,
    COALESCE(SUM(hm.horas) FILTER (WHERE hm.naturaleza = 'INTERNA'), 0)::integer AS horas_internas,
    COALESCE(SUM(hm.horas) FILTER (WHERE hm.naturaleza = 'EXTERNA'), 0)::integer AS horas_externas,
    COALESCE(SUM(hm.horas), 0)::integer                                 AS horas_totales,
    COUNT(DISTINCT pe.id)::integer                                      AS participaciones,
    COALESCE(SUM(hm.horas) FILTER (WHERE hm.origen = 'MANUAL'), 0)::integer      AS horas_manuales
FROM students s
LEFT JOIN project_enrollments pe ON pe.student_id = s.id
LEFT JOIN hour_movements hm      ON hm.enrollment_id = pe.id
GROUP BY s.id;
