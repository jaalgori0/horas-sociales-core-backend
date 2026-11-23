-- =============================================================================
-- 012_facultad_comunicaciones_mercadeo.sql
-- Descripción: reagrupación final de facultades (tres, nombres oficiales "Facultad de …").
--
--   Facultad de Ingeniería y Arquitectura        sin cambios (Diseño ya está aquí, 009).
--   Facultad de Ciencias Sociales y Humanidades  pierde Comunicación Social; conserva
--                                                Ciencias Jurídicas, Licenciatura y
--                                                Profesorado en Teología, etc.
--   Facultad de Comunicaciones y Mercadeo        NUEVO NOMBRE de "Facultad de Ciencias
--                                                Económicas y Empresariales" + Comunicación
--                                                Social. Reúne gestión empresarial, economía
--                                                y mercadeo.
--
-- • Se RENOMBRA la facultad (mismo id), no se crea otra: projects.faculty_id y cualquier
--   referencia existente siguen apuntando a ella sin tocar datos.
-- • Solo cambia faculties.nombre y careers.faculty_id; la facultad de estudiantes y
--   proyectos se deriva por llave foránea en todo el sistema.
-- • No se editan 003/009/010 (aplicadas; el runner valida su checksum).
-- • Idempotente.
-- =============================================================================

SELECT set_config('app.actor', 'migracion:012_facultad_comunicaciones_mercadeo', true);

-- 1. Renombrar Ciencias Económicas y Empresariales → Comunicaciones y Mercadeo.
UPDATE faculties
   SET nombre = 'Facultad de Comunicaciones y Mercadeo'
 WHERE nombre_normalizado = fn_normalize_text('Facultad de Ciencias Económicas y Empresariales')
   AND NOT EXISTS (SELECT 1 FROM faculties
                    WHERE nombre_normalizado = fn_normalize_text('Facultad de Comunicaciones y Mercadeo'));

-- 2. Carreras de la facultad (nombres del catálogo oficial 003 + 010).
UPDATE careers c
   SET faculty_id = f.id
  FROM faculties f
 WHERE f.nombre_normalizado = fn_normalize_text('Facultad de Comunicaciones y Mercadeo')
   AND c.nombre_normalizado IN (
         fn_normalize_text('Licenciatura en Comunicación Social'),
         fn_normalize_text('Licenciatura en Mercadeo'),
         fn_normalize_text('Técnico en Marketing Digital'),
         fn_normalize_text('Licenciatura en Administración de Empresas'),
         fn_normalize_text('Licenciatura en Contaduría Pública'),
         fn_normalize_text('Técnico en Contaduría'),
         fn_normalize_text('Licenciatura en Economía'),
         fn_normalize_text('Licenciatura en Finanzas'))
   AND c.faculty_id IS DISTINCT FROM f.id;

-- 3. Red de seguridad: tres facultades con el reparto esperado.
DO $$
DECLARE
    v_mal text;
BEGIN
    IF (SELECT count(*) FROM faculties) <> 3
       OR NOT EXISTS (SELECT 1 FROM faculties WHERE nombre_normalizado = fn_normalize_text('Facultad de Comunicaciones y Mercadeo'))
       OR EXISTS (SELECT 1 FROM faculties WHERE nombre_normalizado = fn_normalize_text('Facultad de Ciencias Económicas y Empresariales')) THEN
        RAISE EXCEPTION 'Reagrupación 012: se esperaban exactamente las 3 facultades oficiales (Ingeniería y Arquitectura, Ciencias Sociales y Humanidades, Comunicaciones y Mercadeo)';
    END IF;

    SELECT string_agg(e.carrera || ' → ' || coalesce(f.nombre, '(no existe)'), '; ') INTO v_mal
    FROM (VALUES
        ('Licenciatura en Comunicación Social',        'Facultad de Comunicaciones y Mercadeo'),
        ('Licenciatura en Mercadeo',                   'Facultad de Comunicaciones y Mercadeo'),
        ('Técnico en Marketing Digital',               'Facultad de Comunicaciones y Mercadeo'),
        ('Licenciatura en Administración de Empresas', 'Facultad de Comunicaciones y Mercadeo'),
        ('Licenciatura en Contaduría Pública',         'Facultad de Comunicaciones y Mercadeo'),
        ('Técnico en Contaduría',                      'Facultad de Comunicaciones y Mercadeo'),
        ('Licenciatura en Economía',                   'Facultad de Comunicaciones y Mercadeo'),
        ('Licenciatura en Finanzas',                   'Facultad de Comunicaciones y Mercadeo'),
        ('Licenciatura en Ciencias Jurídicas',         'Facultad de Ciencias Sociales y Humanidades'),
        ('Licenciatura en Teología',                   'Facultad de Ciencias Sociales y Humanidades'),
        ('Profesorado en Teología',                    'Facultad de Ciencias Sociales y Humanidades'),
        ('Licenciatura en Diseño',                     'Facultad de Ingeniería y Arquitectura')
    ) AS e (carrera, facultad)
    LEFT JOIN careers c   ON c.nombre_normalizado = fn_normalize_text(e.carrera)
    LEFT JOIN faculties f ON f.id = c.faculty_id
    WHERE f.nombre_normalizado IS DISTINCT FROM fn_normalize_text(e.facultad);

    IF v_mal IS NOT NULL THEN
        RAISE EXCEPTION 'Reagrupación 012: carreras fuera de su facultad: %', v_mal;
    END IF;
END;
$$;
