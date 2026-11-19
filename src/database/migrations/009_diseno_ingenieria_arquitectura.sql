-- =============================================================================
-- 009_diseno_ingenieria_arquitectura.sql
-- Descripción: la Licenciatura en Diseño pertenece a la Facultad de Ingeniería y
-- Arquitectura (no a Ciencias Sociales y Humanidades, como la sembró 003).
--
-- • Solo cambia careers.faculty_id: los estudiantes de Diseño pasan a contar en
--   Ingeniería y Arquitectura en todo el sistema (dashboard, filtros, proyectos con
--   facultad derivada), porque la facultad siempre se obtiene por llave foránea.
-- • No se edita 003 (ya aplicada; el runner valida su checksum): en una base nueva
--   003 la siembra en Sociales y esta migración la mueve.
-- • No toca projects.faculty_id: es una elección explícita del usuario.
-- • Idempotente: si ya está en Ingeniería y Arquitectura no hace nada.
-- =============================================================================

SELECT set_config('app.actor', 'migracion:009_diseno_ingenieria_arquitectura', true);

UPDATE careers c
   SET faculty_id = f.id
  FROM faculties f
 WHERE f.nombre_normalizado = fn_normalize_text('Facultad de Ingeniería y Arquitectura')
   AND c.nombre_normalizado = fn_normalize_text('Licenciatura en Diseño')
   AND c.faculty_id IS DISTINCT FROM f.id;

-- Red de seguridad: si la carrera existe, debe quedar en Ingeniería y Arquitectura.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM careers c
          JOIN faculties f ON f.id = c.faculty_id
         WHERE c.nombre_normalizado = fn_normalize_text('Licenciatura en Diseño')
           AND f.nombre_normalizado <> fn_normalize_text('Facultad de Ingeniería y Arquitectura')
    ) THEN
        RAISE EXCEPTION 'La Licenciatura en Diseño no quedó en la Facultad de Ingeniería y Arquitectura';
    END IF;
END;
$$;
