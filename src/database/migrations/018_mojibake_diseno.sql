-- =============================================================================
-- 018_mojibake_diseno.sql
-- Descripción: "DISEÑO" llega dañado en el PDF de Arquitectura de noviembre 2026, en dos
-- formas: "DISEÃ?O" (como el resto del mapa) y "DISEÃ??O" (con dos signos). Sin el
-- mapeo, las filas quedan en conflicto por mojibake_sin_mapeo y no se cargan.
-- Ninguna de las dos formas es subcadena de la otra ni de otra entrada del mapa, así
-- que el orden de reemplazo en fn_import_corregir_mojibake no importa.
-- Idempotente.
-- =============================================================================

SELECT set_config('app.actor', 'migracion:018_mojibake_diseno', true);

INSERT INTO import_map_mojibake (roto, correcto) VALUES
    ('DISEÃ?O',  'DISEÑO'),
    ('DISEÃ??O', 'DISEÑO')
ON CONFLICT (roto) DO NOTHING;
