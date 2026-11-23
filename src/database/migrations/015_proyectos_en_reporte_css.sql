-- =============================================================================
-- 015_proyectos_en_reporte_css.sql
-- Descripción: marca explícita de los proyectos que vienen en el Excel CSS
-- («Memoria de Labores», ReporteEstadisticoCSS.xls), frente a los que solo aparecen en
-- los PDF de horas por carrera (otro correlativo del mismo proyecto, grupos que el Excel
-- no lista, etc.). Revisión de la tarjeta «Proyectos totales» del 23/11/2026.
--
-- 1. projects.en_reporte_css (boolean, NOT NULL, default false): true si alguna carga
--    (ETL histórico o importación masiva) encontró el proyecto, por (código CSS de la
--    institución, correlativo), en una fila del Excel. Solo pasa de false a true: un
--    Excel posterior que ya no traiga el proyecto no borra la marca.
-- 2. Línea base: los proyectos con `area_css` o `alumnos_css` en atributos. Esos dos
--    campos solo los escribe una fila del Excel (los PDF no traen área ni alumnos), así
--    que la marca es exacta para ellos. Un proyecto del Excel que se creó desde un PDF
--    sin el Excel en el lote queda en false hasta que se vuelva a importar el Excel.
-- =============================================================================

SELECT set_config('app.actor', 'migracion:015_proyectos_en_reporte_css', true);

ALTER TABLE projects ADD COLUMN en_reporte_css boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN projects.en_reporte_css IS
    'true: el proyecto viene en el Excel CSS «Memoria de Labores» (por código de institución + correlativo). false: solo en los PDF de horas o creado en la app.';

UPDATE projects
SET en_reporte_css = true
WHERE atributos ?| ARRAY['area_css', 'alumnos_css'];
