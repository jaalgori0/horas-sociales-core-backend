-- =============================================================================
-- 006_institution_location_rules.sql
-- Descripción: reglas de asociación institución (código CSS) → ubicación.
--
-- Los reportes del CSS no traen la ubicación de la institución. Sin ella, todo
-- proyecto importado cae en "Sin ubicación" en el dashboard (gráfico de
-- estudiantes por municipio, mapa, KPI de municipios).
--
-- Al confirmar una importación (y con `pnpm etl:enrich`) se completan las
-- instituciones y proyectos con ubicación vacía, en este orden:
--   1. Institución: regla de esta tabla por codigo_css → nombre de la institución
--      (topónimo inequívoco) → UCA.
--   2. Proyecto: título del proyecto → ubicación de su institución.
-- Solo se llenan valores vacíos: lo que un usuario edite en la app nunca se pisa.
--
-- Formato de `ubicacion`: "Municipio, Departamento" (o el país, si es extranjera),
-- el mismo que entiende shared/geo-el-salvador.ts, que deriva el departamento.
--
-- Semilla: instituciones recurrentes de los reportes cuya ubicación ya fue
-- revisada en la carga histórica. Para agregar una institución nueva:
--   INSERT INTO institution_location_rules (codigo_css, ubicacion)
--   VALUES ('1234', 'Soyapango, San Salvador');
-- y ejecutar `pnpm etl:enrich --aplicar` (o confirmar la próxima importación).
-- =============================================================================

SELECT set_config('app.actor', 'migracion:006_institution_location_rules', true);

CREATE TABLE institution_location_rules (
    codigo_css  text        PRIMARY KEY CHECK (btrim(codigo_css) <> ''),
    ubicacion   text        NOT NULL CHECK (btrim(ubicacion) <> ''),
    nota        text,
    creado_en   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE institution_location_rules IS
    'Ubicación ("Municipio, Departamento") de instituciones del CSS por código. La usa la importación para completar institutions.ubicacion vacía.';

INSERT INTO institution_location_rules (codigo_css, ubicacion) VALUES
    ('1893', 'Aguilares, San Salvador'),            -- ASOCIACION COOPERATIVA ACOOAPASER EL MANGUITO
    ('528',  'Antiguo Cuscatlán, La Libertad'),     -- ASOCIACION HABITAT PARA LA HUMANIDAD EL SALVADOR
    ('1628', 'San Salvador, San Salvador'),         -- ASOCIACION SERVICIO SOLIDARIO CVX
    ('1818', 'San Luis Talpa, La Paz'),             -- AVIACION CIVIL
    ('1720', 'San Salvador, San Salvador'),         -- CENTRO ESCOLAR CATOLICO EMILIANI
    ('847',  'San Salvador, San Salvador'),         -- CENTRO ESCOLAR JUANA LOPEZ - SAN ANTONIO ABAD
    ('2083', 'Soyapango, San Salvador'),            -- CENTRO ESCOLAR JULIAN VASQUEZ ROJAS
    ('626',  'San Salvador, San Salvador'),         -- CENTRO ESCOLAR MARCELINO GARCIA FLAMENCO
    ('2082', 'Cojutepeque, Cuscatlán'),             -- CENTRO ESCOLAR SANTA ISABEL
    ('41',   'San Salvador, San Salvador'),         -- COLEGIO EXTERNADO DE SAN JOSE
    ('135',  'San Salvador, San Salvador'),         -- COMISION EJECUTIVA HIDROELECTRICA DEL RIO LEMPA
    ('1846', 'San Salvador, San Salvador'),         -- COMPLEJO EDUCATIVO JUAN ERNESTO DE BEDOUT
    ('2030', 'San Luis del Carmen, Chalatenango'),  -- COMUNIDAD CATOLICA SAN LUIS DEL CARMEN
    ('37',   'San Salvador, San Salvador'),         -- CRUZ ROJA SALVADOREÑA
    ('2085', 'San Salvador, San Salvador'),         -- DIRECCION DE INTEGRACION GOBIERNO DE EL SALVADOR
    ('447',  'San Salvador, San Salvador'),         -- ESCUELA DE NIÑAS RAMON BELLOSO
    ('2087', 'San Salvador, San Salvador'),         -- FUNDA HABLA
    ('2068', 'San Salvador, San Salvador'),         -- FUNDACION QUINTANILLA AMAYA
    ('1845', 'San Salvador, San Salvador'),         -- FUNDACION REDENTOR
    ('496',  'San Salvador, San Salvador'),         -- FUNDACION SALVADORENA DE APOYO INTEGRAL/FUSAI
    ('2080', 'La Libertad, La Libertad'),           -- FUNDACION SURFTISMO EL SALVADOR
    ('1772', 'San Salvador, San Salvador'),         -- FUNDAGONDRA
    ('1934', 'Soyapango, San Salvador'),            -- INSTITUTO DE EDUC LAURA VICUNA Y ORATORIO
    ('1928', 'Santa Tecla, La Libertad'),           -- ISC INSTITUTO SALVADORENO DEL CAFE
    ('86',   'Santa Tecla, La Libertad'),           -- MINISTERIO DE AGRICULTURA Y GANADERIA
    ('28',   'San Salvador, San Salvador'),         -- MINISTERIO DE ECONOMIA
    ('65',   'San Salvador, San Salvador'),         -- MINISTERIO DE EDUCACION CIENCIA Y TECNOLOGIA
    ('1851', 'San Salvador, San Salvador'),         -- MINISTERIO DE VIVIENDA
    ('576',  'San Salvador, San Salvador'),         -- MUSEO DE LOS NIÑOS TIN MARIN
    ('535',  'San Salvador, San Salvador'),         -- OPAMSS
    ('227',  'San Salvador, San Salvador'),         -- PROCURADURIA GENERAL DE LA REPUBLICA
    ('477',  'Antiguo Cuscatlán, La Libertad');     -- PROVINCIA C.A. DE LA COMPANIA DE JESUS
