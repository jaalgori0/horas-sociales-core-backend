-- =============================================================================
-- 013_import_revision_en_linea.sql
-- Descripción: revisión en línea de la importación (sin editar Excel).
--
-- Fase B — participaciones existentes que cambian en un corte posterior:
--   • import_items.accion admite 'ACTUALIZAR': la participación existente (estudiante +
--     proyecto) se actualiza al confirmar (estado, cierre y horas del CSS).
--   • import_enrollment_decisions: decisión explícita sobre una participación en
--     conflicto que la admite (aumento de horas en una participación ya FINALIZADA):
--     ACEPTAR_REPORTE o CONSERVAR_BD. Guarda los valores sobre los que se decidió: si la
--     base o el reporte cambian, la decisión deja de aplicar (vuelve a CONFLICTO).
--
-- Fase A — filas del PDF corregidas o excluidas desde la vista previa:
--   • import_pdf_row_overrides: estado VIGENTE de la corrección de una fila (solo los
--     campos editados; NULL = sin cambio) o su exclusión. import_pdf_rows NO se modifica:
--     el valor extraído del PDF queda intacto como original.
--
-- Auditoría:
--   • import_review_log: bitácora de solo inserción (trigger que impide UPDATE/DELETE
--     salvo el borrado en cascada del lote) con valor original, nuevo, justificación,
--     usuario y fecha de cada edición, exclusión, restauración o decisión.
--
-- Caducidad: una vista previa con revisiones guardadas no se purga al vencer (se
-- conserva 7 días más para poder renovarla). La regla vive en la app (createPreview).
-- =============================================================================

SELECT set_config('app.actor', 'migracion:013_import_revision_en_linea', true);

-- -----------------------------------------------------------------------------
-- 1. Acción ACTUALIZAR en los ítems
-- -----------------------------------------------------------------------------
ALTER TABLE import_items DROP CONSTRAINT ck_import_items_accion;
ALTER TABLE import_items ADD CONSTRAINT ck_import_items_accion
    CHECK (accion IN ('INSERTAR', 'COMPLETAR', 'ACTUALIZAR', 'NINGUNA'));
-- ACTUALIZAR solo existe para participaciones.
ALTER TABLE import_items ADD CONSTRAINT ck_import_items_actualizar
    CHECK (accion <> 'ACTUALIZAR' OR entidad = 'PARTICIPACION');

-- -----------------------------------------------------------------------------
-- 2. Correcciones vigentes de filas del PDF
-- -----------------------------------------------------------------------------
CREATE TABLE import_pdf_row_overrides (
    batch_id        uuid        NOT NULL,
    pdf_row_id      bigint      NOT NULL,
    -- Valores con el MISMO formato que el reporte (los re-valida classify.sql):
    estado          text,                   -- 'Activo' | 'Finalizado' | 'Abandonado'
    horas_asignadas text,                   -- entero como texto
    fecha_inicio    text,                   -- 'DD/MM/AAAA'
    fecha_fin       text,                   -- 'DD/MM/AAAA' o '01/01/1900' (sin fecha)
    excluida        boolean     NOT NULL DEFAULT false,
    justificacion   text        NOT NULL,   -- la de la última acción vigente
    actualizado_por text        NOT NULL DEFAULT fn_current_actor(),
    actualizado_en  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_import_pdf_row_overrides PRIMARY KEY (batch_id, pdf_row_id),
    CONSTRAINT fk_import_pdf_row_overrides_batch FOREIGN KEY (batch_id)
        REFERENCES import_batches (id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_import_pdf_row_overrides_row FOREIGN KEY (pdf_row_id)
        REFERENCES import_pdf_rows (id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT ck_import_pdf_row_overrides_estado CHECK (estado IS NULL OR estado IN ('Activo', 'Finalizado', 'Abandonado')),
    CONSTRAINT ck_import_pdf_row_overrides_horas CHECK (horas_asignadas IS NULL OR horas_asignadas ~ '^\d{1,6}$'),
    CONSTRAINT ck_import_pdf_row_overrides_fechas CHECK (
        (fecha_inicio IS NULL OR fecha_inicio ~ '^\d{2}/\d{2}/\d{4}$')
        AND (fecha_fin IS NULL OR fecha_fin ~ '^\d{2}/\d{2}/\d{4}$')),
    CONSTRAINT ck_import_pdf_row_overrides_justificacion CHECK (length(btrim(justificacion)) >= 5)
);
COMMENT ON TABLE import_pdf_row_overrides IS
    'Corrección vigente (o exclusión) de una fila del PDF hecha en la vista previa. import_pdf_rows conserva el original.';

-- -----------------------------------------------------------------------------
-- 3. Decisiones sobre participaciones en conflicto
-- -----------------------------------------------------------------------------
CREATE TABLE import_enrollment_decisions (
    batch_id         uuid        NOT NULL,
    clave            text        NOT NULL,   -- import_items.clave: carnet@codigo/correlativo
    decision         text        NOT NULL,
    -- Valores sobre los que se decidió (horas CSS en la base y en el reporte).
    horas_existentes integer     NOT NULL,
    horas_reporte    integer     NOT NULL,
    justificacion    text        NOT NULL,
    decidido_por     text        NOT NULL DEFAULT fn_current_actor(),
    decidido_en      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_import_enrollment_decisions PRIMARY KEY (batch_id, clave),
    CONSTRAINT fk_import_enrollment_decisions_batch FOREIGN KEY (batch_id)
        REFERENCES import_batches (id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT ck_import_enrollment_decisions_decision CHECK (decision IN ('ACEPTAR_REPORTE', 'CONSERVAR_BD')),
    CONSTRAINT ck_import_enrollment_decisions_justificacion CHECK (length(btrim(justificacion)) >= 5)
);

-- -----------------------------------------------------------------------------
-- 4. Bitácora de revisión (solo inserción)
-- -----------------------------------------------------------------------------
CREATE TABLE import_review_log (
    id              bigint      GENERATED ALWAYS AS IDENTITY,
    batch_id        uuid        NOT NULL,
    accion          text        NOT NULL,
    pdf_row_id      bigint,                  -- EDITAR / EXCLUIR / RESTAURAR
    clave           text,                    -- DECIDIR (participación)
    valor_original  jsonb,                   -- lo extraído del PDF o lo que hay en la base
    valor_anterior  jsonb,                   -- corrección vigente antes de esta acción
    valor_nuevo     jsonb,
    justificacion   text        NOT NULL,
    actor           text        NOT NULL DEFAULT fn_current_actor(),
    creado_en       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_import_review_log PRIMARY KEY (id),
    CONSTRAINT fk_import_review_log_batch FOREIGN KEY (batch_id)
        REFERENCES import_batches (id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT ck_import_review_log_accion CHECK (accion IN ('EDITAR', 'EXCLUIR', 'RESTAURAR', 'DECIDIR')),
    CONSTRAINT ck_import_review_log_objetivo CHECK (
        (accion = 'DECIDIR') = (clave IS NOT NULL) AND (accion = 'DECIDIR') = (pdf_row_id IS NULL)),
    CONSTRAINT ck_import_review_log_justificacion CHECK (length(btrim(justificacion)) >= 5)
);
CREATE INDEX ix_import_review_log_batch ON import_review_log (batch_id, id);
COMMENT ON TABLE import_review_log IS
    'Bitácora inmutable de la revisión en línea de un lote (ediciones, exclusiones, restauraciones y decisiones).';

-- Inmutable: sin UPDATE; DELETE solo por la cascada del lote (el lote ya no existe).
CREATE FUNCTION fn_import_review_log_inmutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM import_batches b WHERE b.id = OLD.batch_id) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'import_review_log es de solo inserción (% no permitido)', TG_OP;
END;
$$;
CREATE TRIGGER trg_import_review_log_inmutable
    BEFORE UPDATE OR DELETE ON import_review_log
    FOR EACH ROW EXECUTE FUNCTION fn_import_review_log_inmutable();
