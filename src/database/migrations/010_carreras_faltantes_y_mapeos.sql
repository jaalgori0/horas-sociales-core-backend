-- =============================================================================
-- 010_carreras_faltantes_y_mapeos.sql
-- Descripción: carreras que traen los PDF «Detalle de Horas por Proyecto» y que no
-- estaban en el catálogo oficial (003), más los textos abreviados del reporte que no
-- coinciden por nombre normalizado.
--
-- • Carreras nuevas (en la facultad donde se imparten hoy; NO es la reagrupación de
--   facultades, que se revisa aparte):
--     LICENCIATURA EN FINANZAS       → Licenciatura en Finanzas
--     TECNICO EN CONTADURIA          → Técnico en Contaduría
--     TECNICO EN MARKETING DIGITAL   → Técnico en Marketing Digital
--   todas en la Facultad de Ciencias Económicas y Empresariales.
-- • import_map_carreras (004): "LIC. EN ADMINISTRACION DE EMPRESAS" no coincide con
--   "Licenciatura en Administración de Empresas" por la abreviatura. Las modalidades
--   "(SEMIPRESENCIAL)" ya se quitan antes del cruce (fn_import_carrera_sin_modalidad).
-- • project_fields: campo 'alumnos_css' (NUMERO) = alumnos que el Excel «Memoria de
--   Labores» reporta para el proyecto. Es la base de la conciliación contra el total
--   del reporte (inscripciones, sin deduplicar estudiantes).
-- • Idempotente.
-- =============================================================================

SELECT set_config('app.actor', 'migracion:010_carreras_faltantes_y_mapeos', true);

INSERT INTO careers (faculty_id, nombre)
SELECT f.id, c.carrera
FROM (VALUES
    ('Facultad de Ciencias Económicas y Empresariales', 'Licenciatura en Finanzas'),
    ('Facultad de Ciencias Económicas y Empresariales', 'Técnico en Contaduría'),
    ('Facultad de Ciencias Económicas y Empresariales', 'Técnico en Marketing Digital')
) AS c (facultad, carrera)
JOIN faculties f ON f.nombre_normalizado = fn_normalize_text(c.facultad)
ON CONFLICT (nombre_normalizado) DO NOTHING;

INSERT INTO import_map_carreras (carrera_reporte, carrera) VALUES
    ('LIC. EN ADMINISTRACION DE EMPRESAS', 'Licenciatura en Administración de Empresas')
ON CONFLICT (carrera_reporte) DO NOTHING;

INSERT INTO project_fields (clave, etiqueta, tipo, orden)
VALUES ('alumnos_css', 'Alumnos según reporte CSS', 'NUMERO', 101)
ON CONFLICT (clave) DO NOTHING;

-- Red de seguridad: carreras y mapeos deben existir en el catálogo.
DO $$
BEGIN
    IF (SELECT count(*) FROM careers WHERE nombre_normalizado IN (
            fn_normalize_text('Licenciatura en Finanzas'),
            fn_normalize_text('Técnico en Contaduría'),
            fn_normalize_text('Técnico en Marketing Digital'))) <> 3 THEN
        RAISE EXCEPTION 'Faltan carreras nuevas de la migración 010';
    END IF;
    IF EXISTS (SELECT 1 FROM import_map_carreras m
               WHERE NOT EXISTS (SELECT 1 FROM careers c WHERE c.nombre_normalizado = fn_normalize_text(m.carrera))) THEN
        RAISE EXCEPTION 'import_map_carreras apunta a carreras que no existen';
    END IF;
END;
$$;
