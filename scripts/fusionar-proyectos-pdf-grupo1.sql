-- =============================================================================
-- Fusión del "Grupo 1": proyectos que solo aparecen en los PDF de horas pero que el
-- Excel CSS («Memoria de Labores») ya cuenta dentro de un proyecto oficial.
-- Revisión del 23/11/2026.
--
-- Contexto: el PDF por carrera reporta a algunos estudiantes con la institución donde
-- prestan el servicio y el correlativo del MISMO programa registrado en otra
-- institución (casi siempre "REFUERZO ACADEMICO MODALIDADES FLEXIBLES ALTERNAS").
-- La importación crea entonces un proyecto aparte (institución + correlativo) que el
-- Excel no lista, aunque sí cuenta a esos alumnos en su proyecto de la misma
-- institución y el mismo título.
--
-- Un proyecto solo-PDF entra en la fusión si cumple TODO esto:
--   1. No está en el Excel (en_reporte_css = false) y no es el proyecto de sistema.
--   2. Tiene exactamente UN gemelo del Excel: misma institución y mismo título
--      normalizado (nombre_clave).
--   3. Cuadre exacto con el Excel, en los dos niveles:
--      a) proyecto: alumnos_css del gemelo = inscritos del gemelo + inscritos de todos
--         sus proyectos solo-PDF (mismo título e institución);
--      b) institución: total de alumnos_css = inscritos en sus proyectos del Excel +
--         inscritos en sus proyectos solo-PDF, y todos esos solo-PDF tienen gemelo.
--   4. Ninguno de sus estudiantes está ya inscrito en el gemelo.
--   5. No contiene una "inscripción fantasma": activa, con 0 horas, de un estudiante que
--      tiene otra inscripción asignada con 3 días o menos de diferencia (se revisan
--      caso por caso con el CSS y no se tocan aquí).
-- No hay IDs fijos: el criterio se evalúa sobre la base donde se ejecute.
--
-- Qué hace (en una sola transacción):
--   • Mueve las inscripciones al gemelo (project_id); sus horas las siguen (van por
--     enrollment_id). No borra inscripciones ni horas.
--   • Copia al gemelo las carreras del proyecto solo-PDF (project_careers).
--   • Borra el proyecto solo-PDF, que queda vacío.
--   • Registra su (institución, correlativo) como correlativo alterno del gemelo
--     (project_correlativo_alias, origen FUSION, migración 016): la próxima importación
--     de esos PDF usará el proyecto oficial en vez de volver a crear la copia. La base
--     revalida el alias (misma institución, mismo título, destino del reporte CSS).
--   • Sincroniza el estado de los gemelos (fn_sincronizar_estado_proyectos) SIN derivar
--     el cierre de las fechas de los estudiantes: los proyectos del Excel tienen fechas
--     oficiales; solo se finalizan los que ya pasaron su fecha de cierre.
-- Todo queda en `auditoria` con actor 'script:fusion-grupo1-pdf' (antes/después de
-- cada inscripción y la fila completa de cada proyecto borrado): es reversible.
--
-- Uso:
--   Vista previa (por defecto, termina en ROLLBACK, no cambia nada):
--     psql -v ON_ERROR_STOP=1 -f scripts/fusionar-proyectos-pdf-grupo1.sql
--   Aplicar (COMMIT):
--     psql -v ON_ERROR_STOP=1 -v aplicar=1 -f scripts/fusionar-proyectos-pdf-grupo1.sql
-- Requiere: migraciones 015 y 016 aplicadas y el Excel CSS reimportado (en_reporte_css y
-- alumnos_css completos). Si algo no cuadra (un proyecto no queda vacío o un alias no se
-- registra), el script aborta y no cambia nada.
-- =============================================================================

\set QUIET on
\pset pager off
\pset footer off
\if :{?aplicar}
\else
  \set aplicar 0
\endif

BEGIN;
SELECT set_config('app.actor', 'script:fusion-grupo1-pdf', true) \gset

-- Proyectos reales con su clave de comparación.
CREATE TEMP TABLE f_pp ON COMMIT DROP AS
SELECT p.id, p.institution_id, i.codigo_css AS cod, i.nombre AS inst, p.correlativo_css AS corr,
       p.titulo, p.nombre_clave AS clave, p.estado, p.fecha_inicio, p.fecha_cierre,
       p.en_reporte_css AS excel, (p.atributos ->> 'alumnos_css')::int AS alumnos_css
FROM projects p JOIN institutions i ON i.id = p.institution_id
WHERE NOT (p.atributos ? 'sistema');

-- Cuadre por institución contra el Excel.
CREATE TEMP TABLE f_inst ON COMMIT DROP AS
SELECT x.institution_id,
       sum(x.alumnos_css) FILTER (WHERE x.excel)                         AS css,
       sum(n.insc) FILTER (WHERE x.excel)                                AS insc_excel,
       coalesce(sum(n.insc) FILTER (WHERE NOT x.excel), 0)               AS insc_pdf,
       bool_and(x.excel OR EXISTS (SELECT 1 FROM f_pp t
                                   WHERE t.excel AND t.institution_id = x.institution_id
                                     AND t.clave = x.clave))             AS todos_con_gemelo
FROM f_pp x
CROSS JOIN LATERAL (SELECT count(*) AS insc FROM project_enrollments e WHERE e.project_id = x.id) n
GROUP BY x.institution_id;

-- Cuadre por proyecto del Excel con sus gemelos solo-PDF.
CREATE TEMP TABLE f_gem ON COMMIT DROP AS
SELECT t.id AS xls_id, t.alumnos_css,
       (SELECT count(*) FROM project_enrollments e WHERE e.project_id = t.id) AS insc_excel,
       (SELECT count(*) FROM f_pp a JOIN project_enrollments e ON e.project_id = a.id
         WHERE NOT a.excel AND a.institution_id = t.institution_id AND a.clave = t.clave) AS insc_pdf
FROM f_pp t WHERE t.excel;

-- Candidatos: proyecto solo-PDF con un único gemelo del Excel y el motivo si no se fusiona.
CREATE TEMP TABLE f_cand ON COMMIT DROP AS
SELECT a.id AS pdf_id, t.id AS xls_id,
       CASE
         WHEN NOT (fg.alumnos_css = fg.insc_excel + fg.insc_pdf) THEN 'no cuadra el proyecto con el Excel'
         WHEN NOT (fi.todos_con_gemelo AND fi.css = fi.insc_excel + fi.insc_pdf) THEN 'no cuadra la institución con el Excel'
         WHEN EXISTS (SELECT 1 FROM project_enrollments e1
                      JOIN project_enrollments e2 ON e2.student_id = e1.student_id AND e2.project_id = t.id
                      WHERE e1.project_id = a.id) THEN 'estudiante ya inscrito en el gemelo'
         WHEN EXISTS (SELECT 1 FROM project_enrollments g1
                      JOIN project_enrollments g2 ON g2.student_id = g1.student_id AND g2.id <> g1.id
                       AND abs(extract(epoch FROM g2.asignada_en - g1.asignada_en)) <= 3 * 86400
                      WHERE g1.project_id = a.id AND g1.estado IN ('ASIGNADA', 'EN_CURSO')
                        AND NOT EXISTS (SELECT 1 FROM hour_movements h WHERE h.enrollment_id = g1.id))
              THEN 'contiene una inscripción fantasma'
       END AS excluido_por
FROM f_pp a
JOIN f_inst fi ON fi.institution_id = a.institution_id
JOIN LATERAL (SELECT array_agg(t.id) AS ids FROM f_pp t
              WHERE t.excel AND t.institution_id = a.institution_id AND t.clave = a.clave) g ON true
JOIN f_pp t ON t.id = g.ids[1]
JOIN f_gem fg ON fg.xls_id = t.id
WHERE NOT a.excel AND cardinality(g.ids) = 1;

-- Correspondencia proyecto solo-PDF → gemelo del Excel.
CREATE TEMP TABLE f_map ON COMMIT DROP AS
SELECT pdf_id, xls_id FROM f_cand WHERE excluido_por IS NULL;

-- Totales de control antes de fusionar.
CREATE TEMP TABLE f_antes ON COMMIT DROP AS
SELECT (SELECT count(*) FROM projects) AS proyectos,
       (SELECT count(*) FROM project_enrollments) AS inscripciones,
       (SELECT sum(horas) FROM hour_movements) AS horas,
       (SELECT count(*) FROM projects WHERE en_reporte_css) AS proyectos_excel;

\echo
\echo '=== A. Resumen de la fusión ==='
SELECT count(*) AS proyectos_a_fusionar,
       count(DISTINCT m.xls_id) AS proyectos_excel_destino,
       count(DISTINCT a.institution_id) AS instituciones,
       (SELECT count(*) FROM project_enrollments e WHERE e.project_id IN (SELECT pdf_id FROM f_map)) AS inscripciones_a_mover,
       (SELECT coalesce(sum(h.horas), 0) FROM hour_movements h JOIN project_enrollments e ON e.id = h.enrollment_id
         WHERE e.project_id IN (SELECT pdf_id FROM f_map)) AS horas_que_las_acompanan
FROM f_map m JOIN f_pp a ON a.id = m.pdf_id;

\echo
\echo '=== A2. Proyectos solo-PDF con gemelo en el Excel que NO se fusionan (quedan para revisión) ==='
SELECT a.cod || '/' || a.corr AS solo_pdf, t.cod || '/' || t.corr AS gemelo_excel, left(a.inst, 34) AS institucion,
       left(a.titulo, 36) AS titulo, (SELECT count(*) FROM project_enrollments e WHERE e.project_id = a.id) AS insc, c.excluido_por
FROM f_cand c JOIN f_pp a ON a.id = c.pdf_id JOIN f_pp t ON t.id = c.xls_id
WHERE c.excluido_por IS NOT NULL ORDER BY a.cod::int, a.corr::int;

\echo
\echo '=== B. Proyectos solo-PDF → proyecto del Excel (quedan vacíos y se borran) ==='
SELECT a.cod || '/' || a.corr AS solo_pdf, t.cod || '/' || t.corr AS excel_destino,
       left(a.inst, 34) AS institucion, left(a.titulo, 40) AS titulo,
       (SELECT count(*) FROM project_enrollments e WHERE e.project_id = a.id) AS insc,
       (SELECT coalesce(sum(h.horas), 0) FROM hour_movements h JOIN project_enrollments e ON e.id = h.enrollment_id
         WHERE e.project_id = a.id) AS horas,
       a.estado AS estado_pdf, t.estado AS estado_excel
FROM f_map m JOIN f_pp a ON a.id = m.pdf_id JOIN f_pp t ON t.id = m.xls_id
ORDER BY t.cod::int, t.corr::int, a.corr::int;

\echo
\echo '=== C. Inscripciones que se mueven (con sus horas) ==='
SELECT s.carnet, a.cod || '/' || a.corr AS de, t.cod || '/' || t.corr AS a,
       e.estado, (e.asignada_en AT TIME ZONE 'America/El_Salvador')::date AS asignada,
       (e.cerrada_en AT TIME ZONE 'America/El_Salvador')::date AS cerrada,
       (SELECT coalesce(sum(h.horas), 0) FROM hour_movements h WHERE h.enrollment_id = e.id) AS horas
FROM f_map m JOIN f_pp a ON a.id = m.pdf_id JOIN f_pp t ON t.id = m.xls_id
JOIN project_enrollments e ON e.project_id = a.id JOIN students s ON s.id = e.student_id
ORDER BY t.cod::int, t.corr::int, s.carnet;

\echo
\echo '=== D. Advertencias (no impiden la fusión; revisar) ==='
SELECT 'Inscripción activa que llega a un proyecto del Excel FINALIZADO' AS advertencia, count(*) AS casos
FROM f_map m JOIN f_pp t ON t.id = m.xls_id JOIN project_enrollments e ON e.project_id = m.pdf_id
WHERE t.estado = 'FINALIZADO' AND e.estado IN ('ASIGNADA', 'EN_CURSO')
UNION ALL
SELECT 'Asignada antes del inicio del proyecto del Excel', count(*)
FROM f_map m JOIN f_pp t ON t.id = m.xls_id JOIN project_enrollments e ON e.project_id = m.pdf_id
WHERE t.fecha_inicio IS NOT NULL AND (e.asignada_en AT TIME ZONE 'America/El_Salvador')::date < t.fecha_inicio
UNION ALL
SELECT 'Asignada después del cierre del proyecto del Excel', count(*)
FROM f_map m JOIN f_pp t ON t.id = m.xls_id JOIN project_enrollments e ON e.project_id = m.pdf_id
WHERE t.fecha_cierre IS NOT NULL AND (e.asignada_en AT TIME ZONE 'America/El_Salvador')::date > t.fecha_cierre
UNION ALL
SELECT 'Carreras a copiar al proyecto del Excel (project_careers)', count(*)
FROM f_map m JOIN project_careers pc ON pc.project_id = m.pdf_id
WHERE NOT EXISTS (SELECT 1 FROM project_careers c2 WHERE c2.project_id = m.xls_id AND c2.career_id = pc.career_id)
UNION ALL
SELECT 'Citas / marcadores / equipo / vínculos de importación en los proyectos a borrar',
       (SELECT count(*) FROM citas WHERE project_id IN (SELECT pdf_id FROM f_map))
     + (SELECT count(*) FROM map_markers WHERE project_id IN (SELECT pdf_id FROM f_map))
     + (SELECT count(*) FROM project_team_members WHERE project_id IN (SELECT pdf_id FROM f_map))
     + (SELECT count(*) FROM import_project_links WHERE project_id IN (SELECT pdf_id FROM f_map));

-- ── Fusión ──────────────────────────────────────────────────────────────────
INSERT INTO project_careers (project_id, career_id)
SELECT DISTINCT m.xls_id, pc.career_id
FROM f_map m JOIN project_careers pc ON pc.project_id = m.pdf_id
ON CONFLICT DO NOTHING;

UPDATE project_enrollments e
SET project_id = m.xls_id
FROM f_map m
WHERE e.project_id = m.pdf_id;

DELETE FROM projects p
USING f_map m
WHERE p.id = m.pdf_id
  AND NOT EXISTS (SELECT 1 FROM project_enrollments e WHERE e.project_id = p.id);

INSERT INTO project_correlativo_alias
    (institution_id, correlativo_css, project_id, nombre_clave_reporte, origen, justificacion)
SELECT a.institution_id, fn_import_numero(a.corr), m.xls_id, a.clave, 'FUSION',
       format('Fusión Grupo 1 (revisión 23-25/11/2026): el Excel CSS cuenta a estos alumnos en %s/%s; '
              'el PDF de horas los reportaba con el correlativo %s.', t.cod, t.corr, a.corr)
FROM f_map m JOIN f_pp a ON a.id = m.pdf_id JOIN f_pp t ON t.id = m.xls_id;

-- Controles: si algo no cuadra, se aborta (y la transacción no aplica nada).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM projects WHERE id IN (SELECT pdf_id FROM f_map)) THEN
        RAISE EXCEPTION 'Fusión abortada: algún proyecto solo-PDF no quedó vacío';
    END IF;
    IF (SELECT count(*) FROM project_correlativo_alias a JOIN f_map m ON m.xls_id = a.project_id
         JOIN f_pp p ON p.id = m.pdf_id
        WHERE a.institution_id = p.institution_id AND a.correlativo_css = fn_import_numero(p.corr))
       <> (SELECT count(*) FROM f_map) THEN
        RAISE EXCEPTION 'Fusión abortada: no se registraron todos los correlativos alternos';
    END IF;
END $$;

SELECT * FROM fn_sincronizar_estado_proyectos(ARRAY(SELECT DISTINCT xls_id FROM f_map), false) \gset sync_

\echo
\echo '=== E. Verificación después de fusionar ==='
SELECT a.proyectos AS proyectos_antes, (SELECT count(*) FROM projects) AS proyectos_despues,
       a.inscripciones AS insc_antes, (SELECT count(*) FROM project_enrollments) AS insc_despues,
       a.horas AS horas_antes, (SELECT sum(horas) FROM hour_movements) AS horas_despues,
       a.proyectos_excel AS excel_antes, (SELECT count(*) FROM projects WHERE en_reporte_css) AS excel_despues
FROM f_antes a;

\echo
\echo '=== F. Proyectos del Excel destino: alumnos del Excel vs inscritos después de fusionar ==='
SELECT count(*) AS proyectos_destino,
       count(*) FILTER (WHERE t.alumnos_css = n.insc) AS cuadran_exacto,
       count(*) FILTER (WHERE t.alumnos_css <> n.insc) AS no_cuadran
FROM (SELECT DISTINCT xls_id FROM f_map) d JOIN f_pp t ON t.id = d.xls_id
CROSS JOIN LATERAL (SELECT count(*) AS insc FROM project_enrollments e WHERE e.project_id = t.id) n;
\echo '--- Destinos que no cuadran (el cuadre exacto es por institución, no por proyecto)'
SELECT t.cod || '/' || t.corr AS excel, left(t.inst, 34) AS institucion, left(t.titulo, 40) AS titulo,
       t.alumnos_css, n.insc AS inscritos_despues
FROM (SELECT DISTINCT xls_id FROM f_map) d JOIN f_pp t ON t.id = d.xls_id
CROSS JOIN LATERAL (SELECT count(*) AS insc FROM project_enrollments e WHERE e.project_id = t.id) n
WHERE t.alumnos_css <> n.insc;

\echo
\echo '=== G. Proyectos del Excel destino finalizados por fecha oficial vencida (sincronización) ==='
SELECT :'sync_fechas_completadas' AS fechas_cierre_completadas, :'sync_finalizados' AS proyectos_finalizados;

\echo
\echo '=== H. Correlativos alternos registrados (project_correlativo_alias) ==='
SELECT count(*) AS alias_registrados, count(DISTINCT project_id) AS proyectos_oficiales
FROM project_correlativo_alias WHERE origen = 'FUSION';

\if :aplicar
  COMMIT;
  \echo
  \echo '>>> FUSIÓN APLICADA (COMMIT).'
\else
  ROLLBACK;
  \echo
  \echo '>>> VISTA PREVIA: ROLLBACK, la base no cambió. Para aplicar: -v aplicar=1'
\endif
