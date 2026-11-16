/**
 * SCRIPT TEMPORAL — Infiere la ubicación de los proyectos históricos a partir del
 * título del proyecto y del nombre de su institución. Fuera de src/: no entra al build.
 *
 *   npx tsx scripts/tmp-ubicacion-por-texto.ts             # en seco: no escribe nada
 *   npx tsx scripts/tmp-ubicacion-por-texto.ts --aplicar   # actualiza projects.ubicacion
 *
 * Formato guardado en projects.ubicacion (el que ya entienden backend y frontend):
 *   "Municipio, Departamento"   p. ej. "Santa Tecla, La Libertad"
 *   "Departamento"              cuando solo se conoce el departamento
 * El departamento se escribe exactamente como las claves de coordenadasDepartamentos
 * del frontend, para que el mapa lo ubique.
 *
 * Reglas:
 *  1. Primero el título del proyecto; si no menciona un lugar, el nombre de la institución.
 *  2. Se prefiere el municipio (más específico) al departamento; coincidencia por palabra
 *     completa y frase más larga primero ("ANTIGUO CUSCATLAN" antes que "CUSCATLAN").
 *     Si solo se nombra el departamento se guarda SOLO el departamento: no se supone
 *     la cabecera ("PARROQUIA SAN FERNANDO.CHALATENANGO" puede estar en San Fernando).
 *  3. Se descartan frases que contienen un topónimo sin ser un lugar (EXCLUSIONES).
 *  4. Departamentos distintos en el mismo texto → no se asigna.
 *     Instituciones de otro país (solo ese país, sin mención binacional) → ubicación = el país
 *     ("Nicaragua"); fuera del mapa de El Salvador pero ya no cuentan como "Sin ubicación".
 *     Binacionales ("MEXICO - EL SALVADOR") → no se asigna: el nombre no dice dónde se trabajó.
 *  5. Ubicación por defecto: SOLO proyectos de la propia UCA (sede en Antiguo Cuscatlán).
 *     A un proyecto sin ninguna evidencia NO se le inventa ubicación.
 *  6. Solo proyectos con ubicación vacía; nunca se sobrescribe una existente.
 *
 * Reversible: auditoría con actor = 'script:ubicacion-por-texto'.
 *   UPDATE projects SET ubicacion = NULL WHERE id IN (
 *     SELECT registro_id::uuid FROM auditoria
 *      WHERE tabla = 'projects' AND actor = 'script:ubicacion-por-texto');
 *
 * ── Modo --por-institucion (herencia) ──────────────────────────────────────────
 *   npx tsx scripts/tmp-ubicacion-por-texto.ts --por-institucion [--aplicar]
 *
 * Para cada proyecto que sigue sin ubicación, si su INSTITUCIÓN tiene una ubicación
 * válida (district_id, o texto que shared/geo-el-salvador.ts reconoce como
 * departamento de El Salvador o país extranjero), el proyecto la hereda en forma
 * normalizada: "Municipio, Departamento" | "Departamento" | "País". Nunca se copia
 * texto no reconocido. Auditoría con actor = 'script:ubicacion-por-institucion'.
 * Nota: la sede de la institución no siempre es el lugar de ejecución del proyecto.
 */
import { closeDatabase } from '../src/core/config/database.js';
import { execReturning, selectAll, withTransaction } from '../src/core/database/sql.js';
import { resolverUbicacion } from '../src/modules/shared/geo-el-salvador.js';

const ACTOR = 'script:ubicacion-por-texto';
const ACTOR_INSTITUCION = 'script:ubicacion-por-institucion';
const APLICAR = process.argv.includes('--aplicar');
const POR_INSTITUCION = process.argv.includes('--por-institucion');

type Departamento =
  | 'Ahuachapán' | 'Santa Ana' | 'Sonsonate' | 'Chalatenango' | 'La Libertad' | 'San Salvador' | 'Cuscatlán'
  | 'La Paz' | 'Cabañas' | 'San Vicente' | 'Usulután' | 'San Miguel' | 'Morazán' | 'La Unión';

/** Departamentos (nombre exacto de las claves del mapa del frontend). */
const DEPARTAMENTOS: Array<{ clave: string; nombre: Departamento }> = [
  { clave: 'AHUACHAPAN', nombre: 'Ahuachapán' },
  { clave: 'SANTA ANA', nombre: 'Santa Ana' },
  { clave: 'SONSONATE', nombre: 'Sonsonate' },
  { clave: 'CHALATENANGO', nombre: 'Chalatenango' },
  { clave: 'LA LIBERTAD', nombre: 'La Libertad' },
  { clave: 'SAN SALVADOR', nombre: 'San Salvador' },
  { clave: 'CUSCATLAN', nombre: 'Cuscatlán' },
  { clave: 'LA PAZ', nombre: 'La Paz' },
  { clave: 'CABANAS', nombre: 'Cabañas' },
  { clave: 'SAN VICENTE', nombre: 'San Vicente' },
  { clave: 'USULUTAN', nombre: 'Usulután' },
  { clave: 'SAN MIGUEL', nombre: 'San Miguel' },
  { clave: 'MORAZAN', nombre: 'Morazán' },
  { clave: 'LA UNION', nombre: 'La Unión' },
];

/** Municipios (y localidades conocidas) → municipio y departamento. */
const MUNICIPIOS: Array<{ clave: string; municipio: string; departamento: Departamento }> = [
  // San Salvador
  { clave: 'SOYAPANGO', municipio: 'Soyapango', departamento: 'San Salvador' },
  { clave: 'MEJICANOS', municipio: 'Mejicanos', departamento: 'San Salvador' },
  { clave: 'APOPA', municipio: 'Apopa', departamento: 'San Salvador' },
  { clave: 'ILOPANGO', municipio: 'Ilopango', departamento: 'San Salvador' },
  { clave: 'SAN MARCOS', municipio: 'San Marcos', departamento: 'San Salvador' },
  { clave: 'AYUTUXTEPEQUE', municipio: 'Ayutuxtepeque', departamento: 'San Salvador' },
  { clave: 'CUSCATANCINGO', municipio: 'Cuscatancingo', departamento: 'San Salvador' },
  { clave: 'CIUDAD DELGADO', municipio: 'Ciudad Delgado', departamento: 'San Salvador' },
  { clave: 'TONACATEPEQUE', municipio: 'Tonacatepeque', departamento: 'San Salvador' },
  { clave: 'NEJAPA', municipio: 'Nejapa', departamento: 'San Salvador' },
  { clave: 'SAN MARTIN', municipio: 'San Martín', departamento: 'San Salvador' },
  { clave: 'PANCHIMALCO', municipio: 'Panchimalco', departamento: 'San Salvador' },
  { clave: 'SANTIAGO TEXACUANGOS', municipio: 'Santiago Texacuangos', departamento: 'San Salvador' },
  { clave: 'ROSARIO DE MORA', municipio: 'Rosario de Mora', departamento: 'San Salvador' },
  { clave: 'GUAZAPA', municipio: 'Guazapa', departamento: 'San Salvador' },
  { clave: 'AGUILARES', municipio: 'Aguilares', departamento: 'San Salvador' },
  { clave: 'EL PAISNAL', municipio: 'El Paisnal', departamento: 'San Salvador' },
  // La Libertad
  { clave: 'SANTA TECLA', municipio: 'Santa Tecla', departamento: 'La Libertad' },
  { clave: 'NUEVA SAN SALVADOR', municipio: 'Santa Tecla', departamento: 'La Libertad' },
  { clave: 'ANTIGUO CUSCATLAN', municipio: 'Antiguo Cuscatlán', departamento: 'La Libertad' },
  { clave: 'NUEVO CUSCATLAN', municipio: 'Nuevo Cuscatlán', departamento: 'La Libertad' },
  { clave: 'PUERTO DE LA LIBERTAD', municipio: 'La Libertad', departamento: 'La Libertad' },
  { clave: 'ZARAGOZA', municipio: 'Zaragoza', departamento: 'La Libertad' },
  { clave: 'COLON', municipio: 'Colón', departamento: 'La Libertad' },
  { clave: 'LOURDES', municipio: 'Colón', departamento: 'La Libertad' }, // Lourdes, ciudad del municipio de Colón
  { clave: 'QUEZALTEPEQUE', municipio: 'Quezaltepeque', departamento: 'La Libertad' },
  { clave: 'COMASAGUA', municipio: 'Comasagua', departamento: 'La Libertad' },
  { clave: 'TAMANIQUE', municipio: 'Tamanique', departamento: 'La Libertad' },
  { clave: 'CHILTIUPAN', municipio: 'Chiltiupán', departamento: 'La Libertad' },
  { clave: 'HUIZUCAR', municipio: 'Huizúcar', departamento: 'La Libertad' },
  { clave: 'SAN JOSE VILLANUEVA', municipio: 'San José Villanueva', departamento: 'La Libertad' },
  { clave: 'SAN JUAN OPICO', municipio: 'San Juan Opico', departamento: 'La Libertad' },
  { clave: 'CIUDAD ARCE', municipio: 'Ciudad Arce', departamento: 'La Libertad' },
  { clave: 'TEPECOYO', municipio: 'Tepecoyo', departamento: 'La Libertad' },
  { clave: 'JAYAQUE', municipio: 'Jayaque', departamento: 'La Libertad' },
  { clave: 'SACACOYO', municipio: 'Sacacoyo', departamento: 'La Libertad' },
  { clave: 'TEOTEPEQUE', municipio: 'Teotepeque', departamento: 'La Libertad' },
  // Otros departamentos
  { clave: 'SUCHITOTO', municipio: 'Suchitoto', departamento: 'Cuscatlán' },
  { clave: 'COJUTEPEQUE', municipio: 'Cojutepeque', departamento: 'Cuscatlán' },
  { clave: 'SAN PEDRO PERULAPAN', municipio: 'San Pedro Perulapán', departamento: 'Cuscatlán' },
  { clave: 'ZACATECOLUCA', municipio: 'Zacatecoluca', departamento: 'La Paz' },
  { clave: 'OLOCUILTA', municipio: 'Olocuilta', departamento: 'La Paz' },
  { clave: 'SAN LUIS TALPA', municipio: 'San Luis Talpa', departamento: 'La Paz' },
  { clave: 'METAPAN', municipio: 'Metapán', departamento: 'Santa Ana' },
  { clave: 'CHALCHUAPA', municipio: 'Chalchuapa', departamento: 'Santa Ana' },
  { clave: 'JUAYUA', municipio: 'Juayúa', departamento: 'Sonsonate' },
  { clave: 'IZALCO', municipio: 'Izalco', departamento: 'Sonsonate' },
  { clave: 'NAHUIZALCO', municipio: 'Nahuizalco', departamento: 'Sonsonate' },
  { clave: 'ACAJUTLA', municipio: 'Acajutla', departamento: 'Sonsonate' },
  { clave: 'ARMENIA', municipio: 'Armenia', departamento: 'Sonsonate' },
  { clave: 'ATIQUIZAYA', municipio: 'Atiquizaya', departamento: 'Ahuachapán' },
  { clave: 'TACUBA', municipio: 'Tacuba', departamento: 'Ahuachapán' },
  { clave: 'APANECA', municipio: 'Apaneca', departamento: 'Ahuachapán' },
  { clave: 'NUEVA CONCEPCION', municipio: 'Nueva Concepción', departamento: 'Chalatenango' },
  { clave: 'ARCATAO', municipio: 'Arcatao', departamento: 'Chalatenango' },
  { clave: 'SENSUNTEPEQUE', municipio: 'Sensuntepeque', departamento: 'Cabañas' },
  { clave: 'ILOBASCO', municipio: 'Ilobasco', departamento: 'Cabañas' },
  { clave: 'TECOLUCA', municipio: 'Tecoluca', departamento: 'San Vicente' },
  { clave: 'BERLIN', municipio: 'Berlín', departamento: 'Usulután' },
  { clave: 'ALEGRIA', municipio: 'Alegría', departamento: 'Usulután' },
  { clave: 'JIQUILISCO', municipio: 'Jiquilisco', departamento: 'Usulután' },
  { clave: 'PUERTO EL TRIUNFO', municipio: 'Puerto El Triunfo', departamento: 'Usulután' },
  { clave: 'SANTA ELENA', municipio: 'Santa Elena', departamento: 'Usulután' },
  { clave: 'PERQUIN', municipio: 'Perquín', departamento: 'Morazán' },
];

/** Frases que contienen un topónimo sin referirse a ese lugar. Se borran antes de buscar. */
const EXCLUSIONES: Array<[RegExp, string]> = [
  [/\bFE Y ALEGRIA\b/g, 'red educativa "Fe y Alegría", no el municipio de Alegría'],
  [/\bPOR LA PAZ\b/g, '"por la paz", no el departamento de La Paz'],
  [/\b(GENERAL )?FRANCISCO MORAZAN\b/g, 'nombre del prócer, no el departamento de Morazán'],
  [/\bSAN MIGUEL ARCANGEL\b/g, 'nombre del santo, no el departamento de San Miguel'],
  [/\bSAN VICENTE DE PAUL\b/g, 'nombre del santo, no el departamento de San Vicente'],
  [/\bINSTITUTO NACIONAL JOSE SIMEON CANAS\b/g, 'instituto nacional, no la UCA'],
];

const EXTRANJEROS = /\b(NICARAGUA|GUATEMALA|HONDURAS|COSTA RICA|PANAMA|MEXICO)\b/;

/** Instituciones que son la propia UCA (sede: Antiguo Cuscatlán, La Libertad). */
const ES_UCA = /\b(UCA|UNIVERSIDAD CENTROAMERICANA)\b/;
const UBICACION_UCA = 'Antiguo Cuscatlán, La Libertad';

interface Fila {
  id: string;
  titulo: string;
  institucion: string;
}

interface Hallazgo {
  ubicacion: string;
  departamento: Departamento;
  frase: string;
  /** true si identifica un municipio (más específico que solo el departamento). */
  esMunicipio: boolean;
}

/** País del texto normalizado → nombre que se guarda en projects.ubicacion. */
const PAISES: Record<string, string> = {
  NICARAGUA: 'Nicaragua', GUATEMALA: 'Guatemala', HONDURAS: 'Honduras',
  'COSTA RICA': 'Costa Rica', PANAMA: 'Panamá', MEXICO: 'México',
};
const BINACIONAL_CON_EL_SALVADOR = /\bEL SALVADOR\b/;

type Resultado =
  | { tipo: 'texto'; fuente: 'proyecto' | 'institución'; hallazgo: Hallazgo; descartes: string[] }
  | { tipo: 'extranjero'; ubicacion: string; fuente: 'proyecto' | 'institución' }
  | { tipo: 'defecto-uca'; ubicacion: string }
  | { tipo: 'sin-asignar'; motivo: string; descartes: string[] };

function normalizar(texto: string): string {
  return ` ${texto
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()} `;
}

/** Busca lugares en un texto. Devuelve los hallazgos (municipios primero) y las exclusiones aplicadas. */
function buscar(textoOriginal: string): { hallazgos: Hallazgo[]; descartes: string[]; extranjero: string | null } {
  let texto = normalizar(textoOriginal);
  const descartes: string[] = [];
  for (const [patron, motivo] of EXCLUSIONES) {
    if (patron.test(texto)) descartes.push(motivo);
    texto = texto.replace(patron, ' ');
  }
  const extranjero = EXTRANJEROS.exec(texto)?.[1] ?? null;

  const hallazgos: Hallazgo[] = [];
  const candidatos = [
    ...MUNICIPIOS.map((m) => ({
      clave: m.clave, ubicacion: `${m.municipio}, ${m.departamento}`, departamento: m.departamento, esMunicipio: true,
    })),
    ...DEPARTAMENTOS.map((d) => ({ clave: d.clave, ubicacion: d.nombre, departamento: d.nombre, esMunicipio: false })),
  ].sort((a, b) => b.clave.length - a.clave.length); // frase más larga primero

  for (const c of candidatos) {
    const frase = ` ${c.clave} `;
    if (texto.includes(frase)) {
      hallazgos.push({ ubicacion: c.ubicacion, departamento: c.departamento, frase: c.clave, esMunicipio: c.esMunicipio });
      texto = texto.split(frase).join(' '); // consumir: "ANTIGUO CUSCATLAN" no vuelve a contar como "CUSCATLAN"
    }
  }
  // Más específico primero: un municipio gana a la sola mención del departamento.
  hallazgos.sort((a, b) => Number(b.esMunicipio) - Number(a.esMunicipio));
  return { hallazgos, descartes, extranjero };
}

function decidir(fila: Fila): Resultado {
  const descartes: string[] = [];
  for (const [fuente, texto] of [
    ['proyecto', fila.titulo],
    ['institución', fila.institucion],
  ] as const) {
    const r = buscar(texto);
    descartes.push(...r.descartes);
    if (r.extranjero) {
      if (BINACIONAL_CON_EL_SALVADOR.test(normalizar(texto))) {
        return { tipo: 'sin-asignar', motivo: `binacional ${r.extranjero} - EL SALVADOR: no indica dónde se trabajó`, descartes };
      }
      return { tipo: 'extranjero', ubicacion: PAISES[r.extranjero] ?? r.extranjero, fuente };
    }
    const departamentos = new Set(r.hallazgos.map((h) => h.departamento));
    if (departamentos.size > 1) {
      return {
        tipo: 'sin-asignar',
        motivo: `${fuente} menciona varios departamentos (${r.hallazgos.map((h) => h.frase).join(', ')})`,
        descartes,
      };
    }
    if (r.hallazgos.length > 0) return { tipo: 'texto', fuente, hallazgo: r.hallazgos[0]!, descartes };
  }
  if (ES_UCA.test(normalizar(fila.institucion))) return { tipo: 'defecto-uca', ubicacion: UBICACION_UCA };
  return { tipo: 'sin-asignar', motivo: 'sin mención geográfica', descartes };
}

async function main(): Promise<void> {
  const filas = await selectAll<Fila>(
    `SELECT p.id, p.titulo, i.nombre AS institucion
     FROM projects p JOIN institutions i ON i.id = p.institution_id
     WHERE COALESCE(btrim(p.ubicacion), '') = ''
     ORDER BY i.nombre, p.titulo`,
  );
  const resultados = filas.map((fila) => ({ fila, r: decidir(fila) }));
  const asignar = resultados.flatMap(({ fila, r }) =>
    r.tipo === 'texto'
      ? [{ fila, ubicacion: r.hallazgo.ubicacion, r }]
      : r.tipo === 'defecto-uca' || r.tipo === 'extranjero'
        ? [{ fila, ubicacion: r.ubicacion, r }]
        : [],
  );

  console.log(`\nProyectos sin ubicación: ${filas.length}${APLICAR ? '' : '   (MODO EN SECO: no se escribe nada)'}`);

  console.log('\n── Asignados por coincidencia de texto ──');
  for (const { fila, ubicacion, r } of asignar) {
    if (r.tipo !== 'texto') continue;
    console.log(`  ${ubicacion.padEnd(32)} ← "${r.hallazgo.frase}" en ${r.fuente.padEnd(11)} │ ${fila.titulo.slice(0, 48).padEnd(48)} │ ${fila.institucion}`);
  }
  const extranjeros = asignar.filter((a) => a.r.tipo === 'extranjero');
  if (extranjeros.length > 0) {
    console.log('\n── Asignados a otro país ──');
    for (const { fila, ubicacion } of extranjeros) console.log(`  ${ubicacion.padEnd(12)} │ ${fila.titulo.slice(0, 48).padEnd(48)} │ ${fila.institucion}`);
  }
  const porDefecto = asignar.filter((a) => a.r.tipo === 'defecto-uca');
  if (porDefecto.length > 0) {
    console.log('\n── Asignados por defecto (proyectos de la UCA) ──');
    for (const { fila, ubicacion } of porDefecto) console.log(`  ${ubicacion.padEnd(32)} │ ${fila.titulo} │ ${fila.institucion}`);
  }

  // Exclusiones aplicadas (para comprobar que no se perdió un lugar real)
  const conDescartes = resultados.filter(({ r }) => (r.tipo === 'texto' || r.tipo === 'sin-asignar') && r.descartes.length > 0);
  if (conDescartes.length > 0) {
    console.log('\n── Topónimos descartados (no son lugares) ──');
    for (const { fila, r } of conDescartes) {
      if (r.tipo !== 'texto' && r.tipo !== 'sin-asignar') continue;
      console.log(`  ${[...new Set(r.descartes)].join('; ').padEnd(62)} │ ${fila.titulo.slice(0, 40)} │ ${fila.institucion}`);
    }
  }

  const noAsignados = resultados.filter(({ r }) => r.tipo === 'sin-asignar');
  const especiales = noAsignados.filter(({ r }) => r.tipo === 'sin-asignar' && r.motivo !== 'sin mención geográfica');
  if (especiales.length > 0) {
    console.log('\n── Sin asignar por motivo especial ──');
    for (const { fila, r } of especiales) {
      if (r.tipo === 'sin-asignar') console.log(`  ${r.motivo.padEnd(52)} │ ${fila.titulo.slice(0, 44)} │ ${fila.institucion}`);
    }
  }

  // ── Escritura ──
  let actualizados = 0;
  if (APLICAR && asignar.length > 0) {
    actualizados = await withTransaction(async (t) => {
      let total = 0;
      for (const { fila, ubicacion } of asignar) {
        const rows = await execReturning<{ id: string }>(
          `UPDATE projects SET ubicacion = :ubicacion
           WHERE id = :id AND COALESCE(btrim(ubicacion), '') = '' RETURNING id`,
          { id: fila.id, ubicacion },
          t,
        );
        total += rows.length;
      }
      return total;
    }, ACTOR);
  }

  // ── Resumen ──
  const porTexto = asignar.filter((a) => a.r.tipo === 'texto');
  const porDepto = new Map<string, number>();
  for (const a of asignar) {
    const depto = a.ubicacion.split(',').pop()!.trim();
    porDepto.set(depto, (porDepto.get(depto) ?? 0) + 1);
  }
  console.log('\n══════════════ RESUMEN ══════════════');
  console.log(`  Por coincidencia de texto:   ${porTexto.length}`);
  console.log(`     del título del proyecto:  ${porTexto.filter((a) => a.r.tipo === 'texto' && a.r.fuente === 'proyecto').length}`);
  console.log(`     de la institución:        ${porTexto.filter((a) => a.r.tipo === 'texto' && a.r.fuente === 'institución').length}`);
  console.log(`  Otro país:                   ${extranjeros.length}`);
  console.log(`  Por defecto (UCA):           ${porDefecto.length}`);
  console.log(`  Sin asignar:                 ${noAsignados.length}`);
  console.log(`     sin mención geográfica:   ${noAsignados.length - especiales.length}`);
  console.log(`     motivo especial:          ${especiales.length}`);
  console.log(`  Por departamento: ${[...porDepto].sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d} ${n}`).join(' · ')}`);
  console.log(
    APLICAR
      ? `  → Proyectos actualizados en la BD: ${actualizados} (auditoría: actor = '${ACTOR}')`
      : '  → Nada escrito. Ejecute con --aplicar para guardar.',
  );
  console.log('');
}

// ─── Modo --por-institucion ─────────────────────────────────────────────────────
interface FilaHerencia {
  id: string;
  titulo: string;
  institucion: string;
  inst_ubicacion: string | null;
  inst_municipio_fk: string | null;
  inst_departamento_fk: string | null;
}

/** Forma normalizada que se guarda en el proyecto, o null si la ubicación de la institución no es válida. */
function ubicacionHeredable(fila: FilaHerencia): { ubicacion: string; detalle: string } | null {
  const u = resolverUbicacion(fila.inst_ubicacion, { municipio: fila.inst_municipio_fk, departamento: fila.inst_departamento_fk });
  if (u.extranjera) return { ubicacion: u.departamento, detalle: 'país extranjero' };
  if (!u.departamentoReconocido) return null; // vacía o texto no reconocido: no se hereda
  if (u.municipioConocido) return { ubicacion: `${u.municipio}, ${u.departamento}`, detalle: 'municipio' };
  return { ubicacion: u.departamento, detalle: 'solo departamento' };
}

async function heredarDeInstitucion(): Promise<void> {
  const filas = await selectAll<FilaHerencia>(
    `SELECT p.id, p.titulo, i.nombre AS institucion, i.ubicacion AS inst_ubicacion,
            gm.nombre AS inst_municipio_fk, gdep.nombre AS inst_departamento_fk
     FROM projects p
     JOIN institutions i ON i.id = p.institution_id
     LEFT JOIN geo_districts gd       ON gd.id = i.district_id
     LEFT JOIN geo_municipalities gm  ON gm.id = gd.municipality_id
     LEFT JOIN geo_departments gdep   ON gdep.id = gm.department_id
     WHERE COALESCE(btrim(p.ubicacion), '') = ''
     ORDER BY i.nombre, p.titulo`,
  );

  const heredables = filas.flatMap((f) => {
    const h = ubicacionHeredable(f);
    return h ? [{ fila: f, ...h }] : [];
  });
  const instConTextoNoValido = new Map<string, string>();
  for (const f of filas) {
    if (!ubicacionHeredable(f) && (f.inst_ubicacion ?? '').trim()) instConTextoNoValido.set(f.institucion, f.inst_ubicacion!.trim());
  }
  const institucionesSinUbicacion = new Set(filas.filter((f) => !(f.inst_ubicacion ?? '').trim() && !f.inst_departamento_fk).map((f) => f.institucion));

  console.log(`\nProyectos sin ubicación: ${filas.length}${APLICAR ? '' : '   (MODO EN SECO: no se escribe nada)'}`);
  if (heredables.length > 0) {
    console.log('\n── Heredan la ubicación de su institución ──');
    for (const h of heredables) {
      console.log(`  ${h.ubicacion.padEnd(32)} (${h.detalle.padEnd(17)}) │ ${h.fila.titulo.slice(0, 44).padEnd(44)} │ ${h.fila.institucion}`);
    }
  }
  if (instConTextoNoValido.size > 0) {
    console.log('\n── Instituciones con ubicación NO reconocida (no se hereda; corregir el texto) ──');
    for (const [inst, texto] of instConTextoNoValido) console.log(`  "${texto}" │ ${inst}`);
  }

  let actualizados = 0;
  if (APLICAR && heredables.length > 0) {
    actualizados = await withTransaction(async (t) => {
      let total = 0;
      for (const h of heredables) {
        const rows = await execReturning<{ id: string }>(
          `UPDATE projects SET ubicacion = :ubicacion
           WHERE id = :id AND COALESCE(btrim(ubicacion), '') = '' RETURNING id`,
          { id: h.fila.id, ubicacion: h.ubicacion },
          t,
        );
        total += rows.length;
      }
      return total;
    }, ACTOR_INSTITUCION);
  }

  console.log('\n══════════════ RESUMEN (herencia por institución) ══════════════');
  console.log(`  Proyectos revisados (sin ubicación):            ${filas.length}`);
  console.log(`  Rescatados por la ubicación de su institución:  ${heredables.length}`);
  console.log(`  Siguen sin ubicación:                           ${filas.length - heredables.length}`);
  console.log(`     su institución no tiene ubicación:          ${filas.filter((f) => institucionesSinUbicacion.has(f.institucion)).length} proyectos de ${institucionesSinUbicacion.size} instituciones`);
  console.log(`     su institución tiene texto no reconocido:   ${filas.filter((f) => instConTextoNoValido.has(f.institucion)).length}`);
  console.log(
    APLICAR
      ? `  → Proyectos actualizados en la BD: ${actualizados} (auditoría: actor = '${ACTOR_INSTITUCION}')`
      : '  → Nada escrito. Ejecute con --aplicar para guardar.',
  );

  // Dónde completar datos rinde más: instituciones sin ubicación ordenadas por estudiantes afectados.
  const top = await selectAll<{ nombre: string; proyectos: number; estudiantes: number }>(
    `SELECT i.nombre, count(DISTINCT p.id)::int AS proyectos,
            count(DISTINCT pe.student_id) FILTER (WHERE pe.estado IN ('ASIGNADA','EN_CURSO','FINALIZADA'))::int AS estudiantes
     FROM institutions i
     JOIN projects p ON p.institution_id = i.id AND COALESCE(btrim(p.ubicacion), '') = ''
     LEFT JOIN project_enrollments pe ON pe.project_id = p.id
     WHERE COALESCE(btrim(i.ubicacion), '') = '' AND i.district_id IS NULL
     GROUP BY i.id, i.nombre
     ORDER BY estudiantes DESC, proyectos DESC, i.nombre
     LIMIT 10`,
  );
  console.log('\n── Top 10 instituciones sin ubicación (por estudiantes de proyectos sin ubicación) ──');
  for (const t of top) console.log(`  ${String(t.estudiantes).padStart(3)} estudiantes · ${String(t.proyectos).padStart(2)} proyectos │ ${t.nombre}`);
  console.log('');
}

(POR_INSTITUCION ? heredarDeInstitucion() : main())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
