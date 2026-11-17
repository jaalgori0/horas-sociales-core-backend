-- =============================================================================
-- 007_project_status_sync.sql
-- Descripción: regla única para cerrar proyectos vencidos o sin estudiantes activos.
--
-- Problema: projects.estado se calculaba UNA vez, al insertar el proyecto
-- (CASE WHEN fecha_cierre <= current_date ...), y nada lo recalculaba después:
--   A. Un proyecto con cierre futuro seguía ACTIVO cuando esa fecha pasaba.
--   B. Una importación que completaba fecha_cierre no recalculaba el estado.
--   C. El Excel del CSS usa 01/01/1900 como "sin fecha fin" (→ NULL) y esa fecha
--      vacía tapaba el cierre derivado de los estudiantes: proyectos con TODOS sus
--      estudiantes finalizados quedaban ACTIVO sin fecha de cierre, para siempre.
--   D. Editar fecha_cierre a una fecha pasada no cambiaba el estado.
--
-- fn_sincronizar_estado_proyectos(p_ids, p_derivar_cierre):
--   1. (solo con p_derivar_cierre) Proyecto del CSS (correlativo_css) ACTIVO, sin
--      fecha_cierre, con participaciones y ninguna abierta (ASIGNADA/EN_CURSO) →
--      fecha_cierre = último cierre de sus participaciones. Es la misma regla que
--      ya aplicaba el ETL cuando no había Excel. Solo se usa al importar: un
--      proyecto creado o reactivado a mano en la app no se cierra por esta vía.
--   2. Proyecto ACTIVO con fecha_cierre <= hoy (hora de El Salvador) → FINALIZADO.
--      Misma comparación que usa la importación al insertar.
-- Nunca reabre proyectos ni toca BORRADOR/PAUSADO/CANCELADO ni el proyecto de
-- sistema (asignaciones manuales). p_ids NULL = todos los proyectos.
--
-- Quién la llama: esta migración (corrige los datos existentes), la confirmación
-- de importaciones (apply.sql), el ETL histórico (transform_load.sql), la edición
-- de proyectos y una tarea periódica del backend (caso A, paso del tiempo).
-- =============================================================================

SELECT set_config('app.actor', 'migracion:007_project_status_sync', true);

CREATE FUNCTION fn_sincronizar_estado_proyectos(
    p_ids            uuid[]  DEFAULT NULL,
    p_derivar_cierre boolean DEFAULT false
)
RETURNS TABLE (fechas_completadas integer, finalizados integer)
LANGUAGE plpgsql
AS $$
DECLARE
    v_hoy date := (now() AT TIME ZONE 'America/El_Salvador')::date;
BEGIN
    fechas_completadas := 0;
    IF p_derivar_cierre THEN
        WITH cierre AS (
            SELECT pe.project_id,
                   max((pe.cerrada_en AT TIME ZONE 'America/El_Salvador')::date) AS fin
            FROM project_enrollments pe
            WHERE p_ids IS NULL OR pe.project_id = ANY (p_ids)
            GROUP BY pe.project_id
            HAVING bool_and(pe.estado NOT IN ('ASIGNADA', 'EN_CURSO'))
        ),
        upd AS (
            UPDATE projects p
            -- greatest(): respeta ck_projects_fechas si el proyecto inicia después.
            SET fecha_cierre = greatest(p.fecha_inicio, c.fin)
            FROM cierre c
            WHERE c.project_id = p.id
              AND c.fin IS NOT NULL
              AND p.estado = 'ACTIVO'
              AND p.fecha_cierre IS NULL
              AND p.correlativo_css IS NOT NULL
              AND NOT (p.atributos ? 'sistema')
            RETURNING 1
        )
        SELECT count(*)::int INTO fechas_completadas FROM upd;
    END IF;

    WITH upd AS (
        UPDATE projects p
        SET estado = 'FINALIZADO'
        WHERE p.estado = 'ACTIVO'
          AND p.fecha_cierre <= v_hoy
          AND NOT (p.atributos ? 'sistema')
          AND (p_ids IS NULL OR p.id = ANY (p_ids))
        RETURNING 1
    )
    SELECT count(*)::int INTO finalizados FROM upd;

    RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION fn_sincronizar_estado_proyectos(uuid[], boolean) IS
    'Cierra proyectos ACTIVO vencidos (fecha_cierre <= hoy, El Salvador) y, con p_derivar_cierre, '
    'completa fecha_cierre de proyectos del CSS sin participaciones abiertas. Idempotente.';

-- Corrección de los datos existentes.
SELECT * FROM fn_sincronizar_estado_proyectos(NULL, true);
