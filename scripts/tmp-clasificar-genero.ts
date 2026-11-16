/**
 * SCRIPT TEMPORAL — Clasifica el género de los estudiantes históricos del CSS a
 * partir de su primer nombre. No forma parte del build (está fuera de src/).
 *
 *   npx tsx scripts/tmp-clasificar-genero.ts             # en seco: no escribe nada
 *   npx tsx scripts/tmp-clasificar-genero.ts --aplicar   # actualiza students.genero
 *
 * Formato real de students.nombre_completo en el histórico (ver ETL_README.md):
 *
 *   "APELLIDO1, APELLIDO2 NOMBRE1 NOMBRE2"     p. ej. "RECINOS, MARROQUIN LOURDES MARIA"
 *
 * Tras la coma, la primera palabra es el SEGUNDO APELLIDO (con partículas:
 * "DE PAZ", "DEL RIO", "DE LA CRUZ"); el primer nombre es la palabra siguiente.
 *
 * Reglas (solo estudiantes con genero NULL; nunca se sobrescribe un valor existente):
 *   - Primer nombre termina en A y no es excepción masculina → MUJER  (F)
 *   - Primer nombre termina en O y no es excepción femenina  → HOMBRE (M)
 *   - Cualquier otro caso (consonante, E, I, U, unisex, excepción, formato dudoso)
 *     → NO se modifica; se lista para revisión manual.
 *
 * La BD solo admite 'HOMBRE' | 'MUJER' (ck_students_genero).
 * Reversible: cada UPDATE queda en `auditoria` con actor = 'script:genero-por-nombre'.
 *   UPDATE students SET genero = NULL WHERE id IN (
 *     SELECT registro_id::uuid FROM auditoria
 *      WHERE tabla = 'students' AND actor = 'script:genero-por-nombre');
 */
import { closeDatabase } from '../src/core/config/database.js';
import { execReturning, selectAll, withTransaction } from '../src/core/database/sql.js';

const ACTOR = 'script:genero-por-nombre';
const APLICAR = process.argv.includes('--aplicar');

/** Nombres masculinos que terminan en A (no se asignan: van a revisión). */
const EXCEPCIONES_MASCULINAS_A = new Set([
  'JOSHUA', 'JOSUA', 'BAUTISTA', 'LUCA', 'NICOLA', 'JEREMIA', 'ZACARIA', 'ELIA', 'ISAIA',
  'OSEA', 'NOA', 'SASHA', 'MISHA', 'BORJA', 'JONA',
]);
/** Nombres femeninos (o unisex) que terminan en O (no se asignan: van a revisión). */
const EXCEPCIONES_FEMENINAS_O = new Set([
  'AMPARO', 'SOCORRO', 'ROSARIO', 'CONSUELO', 'ROCIO', 'MILAGRO',
]);
/** Partículas que forman parte de un apellido compuesto ("DE LA CRUZ", "DEL RIO"). */
const PARTICULAS = new Set(['DE', 'DEL', 'LA', 'LAS', 'LOS', 'Y', 'VDA', 'VIUDA', 'SAN']);

type Genero = 'HOMBRE' | 'MUJER';

/** Decisiones manuales confirmadas por el usuario (primer nombre → género). */
const ASIGNACION_MANUAL: Record<string, Genero> = {
  MILAGRO: 'MUJER',
};

/**
 * Primeros nombres de género claro que NO terminan en A/O. Solo se usan como
 * protección de la regla del segundo nombre: si el segundo nombre contradice al
 * primero ("JOSE MARIA", "LUZ ANTONIO"…) el caso no se asigna y va a revisión.
 */
const PRIMEROS_MASCULINOS = new Set(['JOSE', 'JUAN', 'LUIS', 'CARLOS', 'JESUS', 'MIGUEL', 'MANUEL', 'ANGEL', 'RENE', 'JORGE']);
const PRIMEROS_FEMENINOS = new Set(['LUZ', 'CARMEN', 'MERCEDES', 'DOLORES', 'LOURDES', 'INES', 'RUTH', 'IRIS', 'BEATRIZ', 'ISABEL']);

type Regla = 'primer-nombre' | 'manual' | 'segundo-nombre' | 'confirmado-usuario' | 'contexto-comun';

/**
 * Clasificación por CARNET (único). `nombres` debe aparecer en nombre_completo:
 * si no coincide, el caso se rechaza (protección contra un carnet mal escrito).
 */
interface PorCarnet {
  genero: Genero;
  nombres: string;
}

/** Confirmados explícitamente por el usuario (formato corto y nombres poco comunes). */
const CONFIRMADOS_USUARIO: Record<string, PorCarnet> = {
  '00115622': { genero: 'HOMBRE', nombres: 'QUINTANILLA RUBEN' },
  '00034822': { genero: 'MUJER', nombres: 'GONZALEZ NATHALIA' },
  '00157722': { genero: 'HOMBRE', nombres: 'GOMAR SEBASTIAN' },
  '00044523': { genero: 'MUJER', nombres: 'KENSSIL NICOLE' },
  '00300821': { genero: 'HOMBRE', nombres: 'NERIS URIEL' },
  '00112622': { genero: 'HOMBRE', nombres: 'ZAIR ISMAEL' },
  '00054919': { genero: 'HOMBRE', nombres: 'EITTELL ALEXANDER' },
  '00140218': { genero: 'HOMBRE', nombres: 'HAXSER OTONIEL' },
};

/**
 * Resto de pendientes, clasificados por uso común del nombre (autorizado por el
 * usuario: "asigna los que sigan claros por sufijo o contexto común").
 */
const POR_CONTEXTO_COMUN: Record<string, PorCarnet> = {
  // ── MUJER ──
  '00167723': { genero: 'MUJER', nombres: 'LISSETTE ANTHUANNE' },
  '00061519': { genero: 'MUJER', nombres: 'KATHERINE YAMILETH' },
  '00040520': { genero: 'MUJER', nombres: 'KEREN LISSETH' },
  '00040420': { genero: 'MUJER', nombres: 'BESSY SARAI' },
  '00018021': { genero: 'MUJER', nombres: 'ELSY LISETTE' },
  '00099321': { genero: 'MUJER', nombres: 'JULIE NICOLE' },
  '00090922': { genero: 'MUJER', nombres: 'KATHERINE STEPHANIE' },
  '00257726': { genero: 'MUJER', nombres: 'GENESIS ESTHER' },
  '00057922': { genero: 'MUJER', nombres: 'ZARAH STEPHANIE' },
  '00538424': { genero: 'MUJER', nombres: 'NATALY IVETT' },
  // ── HOMBRE ──
  '00128520': { genero: 'HOMBRE', nombres: 'JUAN CARLOS' },
  '00000719': { genero: 'HOMBRE', nombres: 'JEFERSON STANLEY' },
  '00041219': { genero: 'HOMBRE', nombres: 'JORGE MIGUEL' },
  '00091019': { genero: 'HOMBRE', nombres: 'OSCAR EMMANUEL' },
  '00303621': { genero: 'HOMBRE', nombres: 'WALTER NOEL' },
  '00401823': { genero: 'HOMBRE', nombres: 'ERICK ALEXIS' },
  '00169324': { genero: 'HOMBRE', nombres: 'JESUS MIGUEL' },
  '00079221': { genero: 'HOMBRE', nombres: 'HAROLD ALEXANDER' },
  '00001820': { genero: 'HOMBRE', nombres: 'BRYAN ALEXIS' },
  '00542224': { genero: 'HOMBRE', nombres: 'ULISSES JOSE' },
  '00121924': { genero: 'HOMBRE', nombres: 'NOEL STANLEY' },
  '00089022': { genero: 'HOMBRE', nombres: 'KEVIN AARON' },
  '00402218': { genero: 'HOMBRE', nombres: 'JONATHAN ALEXANDER' },
  '00032823': { genero: 'HOMBRE', nombres: 'EVER DANIEL' },
  '00079521': { genero: 'HOMBRE', nombres: 'HECTOR ENRIQUE' },
  '00022819': { genero: 'HOMBRE', nombres: 'KEVIN ALEXANDER' },
  '00212720': { genero: 'HOMBRE', nombres: 'JOSE DAVID' },
  '00129320': { genero: 'HOMBRE', nombres: 'DENNYS MANUEL' },
  '00169919': { genero: 'HOMBRE', nombres: 'ALLAN ENRIQUE' },
  '00116322': { genero: 'HOMBRE', nombres: 'JOSUE IVAN' },
  '00390919': { genero: 'HOMBRE', nombres: 'JUAN ESTEBAN' },
  '00120118': { genero: 'HOMBRE', nombres: 'DENIS ALEXANDER' },
  '00242925': { genero: 'HOMBRE', nombres: 'NELSON ARIEL' },
  '00108622': { genero: 'HOMBRE', nombres: 'KEVIN ALEXANDER' },
  '00033518': { genero: 'HOMBRE', nombres: 'CRISTIAN JAVIER' },
  '00058320': { genero: 'HOMBRE', nombres: 'DANIEL ENRIQUE' },
  '00169321': { genero: 'HOMBRE', nombres: 'CARLOS CESAR' },
  '00216720': { genero: 'HOMBRE', nombres: 'MICHAEL MARCEL' },
  '00149024': { genero: 'HOMBRE', nombres: 'MARCOS EMMANUEL' },
  '00151525': { genero: 'HOMBRE', nombres: 'CHRISTOPHER ANDRES' },
  '00031426': { genero: 'HOMBRE', nombres: 'DENNIS GABRIEL' },
  '00237420': { genero: 'HOMBRE', nombres: 'CRISTIAN ARIEL' },
  '00155920': { genero: 'HOMBRE', nombres: 'KENNETH ALEXANDER' },
  '00170820': { genero: 'HOMBRE', nombres: 'JUAN JOSE' },
  '00094514': { genero: 'HOMBRE', nombres: 'MARVIN ALEXANDER' },
  '00303022': { genero: 'HOMBRE', nombres: 'JOSE LUIS' },
  '00542924': { genero: 'HOMBRE', nombres: 'LUIS ENRIQUE' },
  '00058222': { genero: 'HOMBRE', nombres: 'JEFFERSON ADONAY' },
  '00083320': { genero: 'HOMBRE', nombres: 'JOSE RENE' },
  '00014921': { genero: 'HOMBRE', nombres: 'EMERSON ALDAIR' },
  '00043319': { genero: 'HOMBRE', nombres: 'AMILCAR NOEL' },
  '00015823': { genero: 'HOMBRE', nombres: 'EDWARD GEOVANY' },
  '00280319': { genero: 'HOMBRE', nombres: 'DANIEL JARED' },
  '00018324': { genero: 'HOMBRE', nombres: 'JONATHAN JOSUE' },
  '00385719': { genero: 'HOMBRE', nombres: 'BRYAN DAVID' },
  '00038019': { genero: 'HOMBRE', nombres: 'ALEXIS ANDRES' },
  '00262921': { genero: 'HOMBRE', nombres: 'CRISTIAN JOSUE' },
};

interface Fila {
  id: string;
  carnet: string;
  nombre_completo: string;
}

interface Analisis {
  fila: Fila;
  primerNombre: string | null;
  segundoNombre: string | null;
  genero: Genero | null;
  motivo: string;
  /** Regla que asignó el género (null si quedó sin clasificar). */
  regla: Regla | null;
}

/** Mayúsculas sin tildes (Ñ se conserva). */
function normalizar(texto: string): string {
  return texto
    .toUpperCase()
    .replace(/Ñ/g, '\u0000')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\u0000/g, 'Ñ')
    .replace(/[^A-ZÑ\s,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Separa "APELLIDO2 NOMBRES" → nombres, saltando el segundo apellido y sus partículas. */
function extraerNombres(despuesDeComa: string): { nombres: string[]; dudoso: string | null } {
  const palabras = despuesDeComa.split(' ').filter(Boolean);
  let i = 0;
  while (i < palabras.length && PARTICULAS.has(palabras[i]!)) i++; // "DE", "DE LA", ...
  i++; // la palabra del segundo apellido
  const nombres = palabras.slice(i);
  if (nombres.length === 0) return { nombres: [], dudoso: 'no se identifica un nombre tras el segundo apellido' };
  if (palabras.length === 2) {
    // "PEREZ JUAN" o "JUAN CARLOS"? No se puede saber si hay segundo apellido.
    return { nombres, dudoso: 'solo 2 palabras tras la coma: no se distingue apellido de nombre' };
  }
  return { nombres, dudoso: null };
}

function clasificarNombre(nombre: string): { genero: Genero | null; motivo: string } {
  if (nombre.endsWith('A')) {
    if (EXCEPCIONES_MASCULINAS_A.has(nombre)) return { genero: null, motivo: 'termina en A pero es excepción masculina' };
    return { genero: 'MUJER', motivo: 'termina en A' };
  }
  if (nombre.endsWith('O')) {
    if (EXCEPCIONES_FEMENINAS_O.has(nombre)) return { genero: null, motivo: 'termina en O pero es excepción femenina' };
    return { genero: 'HOMBRE', motivo: 'termina en O' };
  }
  return { genero: null, motivo: `termina en "${nombre.slice(-1)}" (no es A/O)` };
}

function analizar(fila: Fila): Analisis {
  const base = { fila, primerNombre: null, segundoNombre: null, genero: null, regla: null } as const;
  const texto = normalizar(fila.nombre_completo);
  const coma = texto.indexOf(',');
  if (coma === -1) return { ...base, motivo: 'sin coma: formato desconocido' };
  const { nombres, dudoso } = extraerNombres(texto.slice(coma + 1).trim());
  const [primer = null, segundo = null] = nombres;
  if (!primer) return { ...base, motivo: dudoso ?? 'sin nombre' };
  const ctx = { ...base, primerNombre: primer, segundoNombre: segundo };

  // 0. Clasificación por carnet (confirmada por el usuario o por uso común del nombre)
  for (const [regla, mapa] of [
    ['confirmado-usuario', CONFIRMADOS_USUARIO],
    ['contexto-comun', POR_CONTEXTO_COMUN],
  ] as const) {
    const entrada = mapa[fila.carnet];
    if (!entrada) continue;
    if (!texto.includes(normalizar(entrada.nombres))) {
      return { ...ctx, motivo: `carnet ${fila.carnet} no coincide con "${entrada.nombres}": revisar la lista` };
    }
    return { ...ctx, genero: entrada.genero, regla, motivo: `${regla}: ${entrada.nombres}` };
  }

  if (dudoso) return { ...ctx, motivo: dudoso };

  // 1. Decisión manual confirmada
  const manual = ASIGNACION_MANUAL[primer];
  if (manual) return { ...ctx, genero: manual, regla: 'manual', motivo: `asignación manual (${primer})` };

  // 2. Primer nombre termina en A / O
  const porPrimero = clasificarNombre(primer);
  if (porPrimero.genero) return { ...ctx, genero: porPrimero.genero, regla: 'primer-nombre', motivo: porPrimero.motivo };
  // Excepción (MILAGRO ya resuelto arriba, JOSHUA…): no se intenta con el segundo nombre.
  if (porPrimero.motivo.includes('excepción')) return { ...ctx, motivo: porPrimero.motivo };

  // 3. Primer nombre no termina en A/O → se mira el segundo nombre
  if (!segundo || PARTICULAS.has(segundo)) {
    return { ...ctx, motivo: 'primer nombre no termina en A/O y no hay segundo nombre utilizable' };
  }
  const porSegundo = clasificarNombre(segundo);
  if (!porSegundo.genero) {
    return { ...ctx, motivo: 'ni el primer ni el segundo nombre terminan en A/O' };
  }
  const contradice =
    (PRIMEROS_MASCULINOS.has(primer) && porSegundo.genero === 'MUJER') ||
    (PRIMEROS_FEMENINOS.has(primer) && porSegundo.genero === 'HOMBRE');
  if (contradice) {
    return { ...ctx, motivo: `el segundo nombre (${segundo}) contradice al primero (${primer})` };
  }
  return { ...ctx, genero: porSegundo.genero, regla: 'segundo-nombre', motivo: `segundo nombre ${porSegundo.motivo}` };
}

async function main(): Promise<void> {
  const filas = await selectAll<Fila>(
    `SELECT id, carnet, nombre_completo FROM students WHERE genero IS NULL ORDER BY nombre_completo`,
  );
  const analisis = filas.map(analizar);
  const asignables = analisis.filter((a): a is Analisis & { genero: Genero } => a.genero !== null);
  const ambiguos = analisis.filter((a) => a.genero === null);

  // ── Detalle de lo que se va a asignar (para poder auditarlo a simple vista) ──
  console.log(`\nEstudiantes con género NULL: ${filas.length}${APLICAR ? '' : '   (MODO EN SECO: no se escribe nada)'}`);
  for (const regla of ['confirmado-usuario', 'contexto-comun', 'manual', 'segundo-nombre', 'primer-nombre'] as const) {
    const lista = asignables.filter((a) => a.regla === regla);
    if (lista.length === 0) continue;
    console.log(`\nAsignados por regla "${regla}" (${lista.length}):`);
    for (const a of lista) {
      const usado = regla === 'segundo-nombre' ? `${a.primerNombre} ${a.segundoNombre}` : String(a.primerNombre);
      console.log(`  ${a.fila.carnet}  ${a.fila.nombre_completo.padEnd(42)} → ${usado.padEnd(24)} → ${a.genero}`);
    }
  }

  // ── Escritura ──
  let actualizados = 0;
  if (APLICAR && asignables.length > 0) {
    actualizados = await withTransaction(async (t) => {
      let total = 0;
      for (const genero of ['MUJER', 'HOMBRE'] as const) {
        const ids = asignables.filter((a) => a.genero === genero).map((a) => a.fila.id);
        if (ids.length === 0) continue;
        const rows = await execReturning<{ id: string }>(
          `UPDATE students SET genero = :genero WHERE id IN (:ids) AND genero IS NULL RETURNING id`,
          { genero, ids },
          t,
        );
        total += rows.length;
      }
      return total;
    }, ACTOR);
  }

  // ── Resumen ──
  const contar = (regla: Regla, genero: Genero) =>
    asignables.filter((a) => a.regla === regla && a.genero === genero).length;
  console.log('\n══════════════ RESUMEN DE ESTA EJECUCIÓN ══════════════');
  for (const [regla, etiqueta] of [
    ['confirmado-usuario', 'Confirmados por el usuario'],
    ['contexto-comun', 'Por uso común del nombre'],
    ['manual', 'Asignación manual (MILAGRO)'],
    ['segundo-nombre', 'Por el 2.º nombre (A/O)'],
    ['primer-nombre', 'Por el 1.er nombre (A/O)'],
  ] as const) {
    const m = contar(regla, 'MUJER');
    const h = contar(regla, 'HOMBRE');
    if (m + h > 0) console.log(`  ${etiqueta.padEnd(30)} ${String(m + h).padStart(3)}   (MUJER ${m} · HOMBRE ${h})`);
  }
  console.log(`  ${'Clasificados en total'.padEnd(30)} ${String(asignables.length).padStart(3)}`);
  console.log(`  ${'Sin clasificar (pendientes)'.padEnd(30)} ${String(ambiguos.length).padStart(3)}`);
  console.log(
    APLICAR
      ? `  → Filas actualizadas en la BD: ${actualizados} (auditoría: actor = '${ACTOR}')`
      : '  → Nada escrito. Ejecute con --aplicar para guardar.',
  );

  // ── Pendientes para revisión manual ──
  console.log('\n══════════ SIN CLASIFICAR (revisión manual) ══════════');
  const porMotivo = new Map<string, Analisis[]>();
  for (const a of ambiguos) {
    const clave = a.motivo.startsWith('el segundo nombre') ? 'El segundo nombre contradice al primero' : a.motivo;
    porMotivo.set(clave, [...(porMotivo.get(clave) ?? []), a]);
  }
  let n = 0;
  for (const [motivo, lista] of porMotivo) {
    console.log(`\n▸ ${motivo} (${lista.length})`);
    console.log(`  ${'#'.padStart(3)}  ${'id'.padEnd(36)}  ${'carnet'.padEnd(8)}  ${'nombre_completo'.padEnd(42)}  nombres`);
    for (const a of lista) {
      n++;
      console.log(
        `  ${String(n).padStart(3)}  ${a.fila.id}  ${a.fila.carnet}  ${a.fila.nombre_completo.padEnd(42)}  ${[a.primerNombre, a.segundoNombre].filter(Boolean).join(' ')}`,
      );
    }
  }
  console.log('');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
