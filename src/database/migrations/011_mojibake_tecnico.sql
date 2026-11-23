-- =============================================================================
-- 011_mojibake_tecnico.sql
-- Descripción: "TÃ?CNICO" (TÉCNICO dañado en el origen) aparece en el Excel y en los
-- PDF de 2026. Sin el mapeo, la fila se rechaza por mojibake_sin_mapeo: en el Excel es
-- un proyecto de 2 alumnos y el total cargado queda en 912 en vez de 914.
-- Idempotente.
-- =============================================================================

SELECT set_config('app.actor', 'migracion:011_mojibake_tecnico', true);

INSERT INTO import_map_mojibake (roto, correcto) VALUES
    ('TÃ?CNICO', 'TÉCNICO')
ON CONFLICT (roto) DO NOTHING;
