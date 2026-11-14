-- =============================================================================
-- 003_seed_uca_faculties.sql
-- Descripción: catálogo oficial de facultades y carreras de la UCA.
--
-- • Las tres facultades de la UCA y sus carreras (nombres únicos, sin modalidad).
-- • Regla: el nombre de una carrera no lleva sufijo de modalidad
--   ("(presencial)", "(semipresencial)", "(virtual)"). Se exige con un CHECK, así
--   aplica tanto al ETL como a lo que se cree desde la app.
-- • Las carreras se enlazan a su facultad por careers.faculty_id (FK NOT NULL) y los
--   estudiantes a su carrera por students.career_id (FK NOT NULL), definidos en 001.
-- • Idempotente: si una facultad o carrera ya existe (mismo nombre normalizado) se
--   conserva su id; a una carrera existente se le asigna la facultad de este catálogo.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Regla de nombres limpios
-- -----------------------------------------------------------------------------
ALTER TABLE careers ADD CONSTRAINT ck_careers_nombre_sin_modalidad
    CHECK (nombre !~* '\(\s*(semi\s*-?\s*presencial|presencial|virtual)\s*\)');

-- -----------------------------------------------------------------------------
-- 2. Facultades
-- -----------------------------------------------------------------------------
INSERT INTO faculties (nombre) VALUES
    ('Facultad de Ciencias Sociales y Humanidades'),
    ('Facultad de Ciencias Económicas y Empresariales'),
    ('Facultad de Ingeniería y Arquitectura')
ON CONFLICT (nombre_normalizado) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. Carreras por facultad
-- -----------------------------------------------------------------------------
INSERT INTO careers (faculty_id, nombre)
SELECT f.id, c.carrera
FROM (VALUES
    ('Facultad de Ingeniería y Arquitectura', 'Arquitectura'),
    ('Facultad de Ingeniería y Arquitectura', 'Ingeniería de Alimentos'),
    ('Facultad de Ingeniería y Arquitectura', 'Ingeniería Civil'),
    ('Facultad de Ingeniería y Arquitectura', 'Ingeniería Eléctrica'),
    ('Facultad de Ingeniería y Arquitectura', 'Ingeniería Energética'),
    ('Facultad de Ingeniería y Arquitectura', 'Ingeniería Industrial'),
    ('Facultad de Ingeniería y Arquitectura', 'Ingeniería Informática'),
    ('Facultad de Ingeniería y Arquitectura', 'Ingeniería Mecánica'),
    ('Facultad de Ingeniería y Arquitectura', 'Ingeniería Química'),

    ('Facultad de Ciencias Sociales y Humanidades', 'Licenciatura en Diseño'),
    ('Facultad de Ciencias Sociales y Humanidades', 'Licenciatura en Ciencias Jurídicas'),
    ('Facultad de Ciencias Sociales y Humanidades', 'Licenciatura en Comunicación Social'),
    ('Facultad de Ciencias Sociales y Humanidades', 'Licenciatura en Filosofía'),
    ('Facultad de Ciencias Sociales y Humanidades', 'Licenciatura en Idioma Inglés'),
    ('Facultad de Ciencias Sociales y Humanidades', 'Licenciatura en Psicología'),
    ('Facultad de Ciencias Sociales y Humanidades', 'Licenciatura en Teología'),
    ('Facultad de Ciencias Sociales y Humanidades', 'Profesorado en Idioma Inglés'),
    ('Facultad de Ciencias Sociales y Humanidades', 'Profesorado en Teología'),

    ('Facultad de Ciencias Económicas y Empresariales', 'Licenciatura en Administración de Empresas'),
    ('Facultad de Ciencias Económicas y Empresariales', 'Licenciatura en Contaduría Pública'),
    ('Facultad de Ciencias Económicas y Empresariales', 'Licenciatura en Economía'),
    ('Facultad de Ciencias Económicas y Empresariales', 'Licenciatura en Mercadeo')
) AS c (facultad, carrera)
JOIN faculties f ON f.nombre_normalizado = fn_normalize_text(c.facultad)
ON CONFLICT (nombre_normalizado) DO UPDATE
    SET faculty_id = EXCLUDED.faculty_id
    WHERE careers.faculty_id IS DISTINCT FROM EXCLUDED.faculty_id;

-- Red de seguridad: el catálogo debe quedar completo (un nombre de facultad mal
-- escrito arriba dejaría carreras fuera del JOIN sin avisar).
DO $$
BEGIN
    IF (SELECT count(*) FROM faculties) < 3 OR (SELECT count(*) FROM careers) < 22 THEN
        RAISE EXCEPTION 'Catálogo UCA incompleto: % facultades, % carreras (se esperaban 3 y 22)',
            (SELECT count(*) FROM faculties), (SELECT count(*) FROM careers);
    END IF;
END;
$$;
