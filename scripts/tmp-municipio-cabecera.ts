/**
 * SCRIPT TEMPORAL — Completa el municipio en ubicaciones que solo tienen el departamento,
 * asignando la CABECERA departamental ("Chalatenango" → "Chalatenango, Chalatenango",
 * "La Libertad" → "Santa Tecla, La Libertad"). Fuera de src/: no entra al build.
 *
 *   npx tsx scripts/tmp-municipio-cabecera.ts             # en seco
 *   npx tsx scripts/tmp-municipio-cabecera.ts --aplicar   # escribe
 *
 * 1. Instituciones cuya ubicación es SOLO un departamento → "Cabecera, Departamento".
 * 2. Proyectos cuya ubicación es SOLO un departamento → "Cabecera, Departamento".
 * 3. Herencia: proyectos que heredaron de una institución corregida en el paso 1
 *    (actor 'script:ubicacion-por-institucion') y conservan ese valor → valor nuevo.
 *
 * Se detecta con resolverUbicacion() (el resolvedor del mapa), no solo por la coma:
 *   - "X, Departamento" con X fuera del catálogo (p. ej. "Colonia Escalón, San Salvador")
 *     NO se toca: tiene un dato del usuario que se perdería. Se lista para revisar.
 *   - Países ("Nicaragua") y texto no reconocido no se tocan.
 *
 * La cabecera es una SUPOSICIÓN: el lugar real puede ser otro municipio del mismo
 * departamento. Reversible: auditoría con actor = 'script:municipio-cabecera'.
 */
import { closeDatabase } from '../src/core/config/database.js';
import { execReturning, selectAll, withTransaction } from '../src/core/database/sql.js';
import { resolverUbicacion, type Departamento } from '../src/modules/shared/geo-el-salvador.js';

const ACTOR = 'script:municipio-cabecera';
const ACTOR_HERENCIA = 'script:ubicacion-por-institucion';
const APLICAR = process.argv.includes('--aplicar');

/** Cabeceras departamentales de El Salvador. */
const CABECERA: Record<Departamento, string> = {
  'Ahuachapán': 'Ahuachapán',
  'Santa Ana': 'Santa Ana',
  'Sonsonate': 'Sonsonate',
  'Chalatenango': 'Chalatenango',
  'La Libertad': 'Santa Tecla',
  'San Salvador': 'San Salvador',
  'Cuscatlán': 'Cojutepeque',
  'La Paz': 'Zacatecoluca',
  'Cabañas': 'Sensuntepeque',
  'San Vicente': 'San Vicente',
  'Usulután': 'Usulután',
  'San Miguel': 'San Miguel',
  'Morazán': 'San Francisco Gotera',
  'La Unión': 'La Unión',
};

interface Registro {
  id: string;
  nombre: string;
  ubicacion: string;
  extra?: string;
}

type Clasificacion =
  | { tipo: 'completar'; nueva: string }
  | { tipo: 'revisar'; motivo: string }
  | { tipo: 'ok' };

function clasificar(ubicacion: string): Clasificacion {
  const u = resolverUbicacion(ubicacion);
  if (!u.departamentoReconocido || u.municipioConocido) return { tipo: 'ok' };
  // Departamento reconocido pero sin municipio conocido:
  if (u.municipio.endsWith(' (sin municipio)')) {
    const depto = u.departamento as Departamento;
    return { tipo: 'completar', nueva: `${CABECERA[depto]}, ${depto}` };
  }
  return { tipo: 'revisar', motivo: `"${u.municipio}" no es un municipio del catálogo` };
}

function imprimir(titulo: string, lista: Array<Registro & { nueva?: string; motivo?: string }>): void {
  console.log(`\n── ${titulo} (${lista.length}) ──`);
  for (const r of lista) {
    const destino = r.nueva ? `→ ${r.nueva}` : `(${r.motivo})`;
    console.log(`  ${JSON.stringify(r.ubicacion).padEnd(16)} ${destino.padEnd(36)} │ ${r.nombre.slice(0, 50)}${r.extra ? ` │ ${r.extra}` : ''}`);
  }
}

async function main(): Promise<void> {
  const instituciones = await selectAll<Registro>(
    `SELECT id, nombre, ubicacion FROM institutions WHERE COALESCE(btrim(ubicacion), '') <> '' ORDER BY nombre`,
  );
  const proyectos = await selectAll<Registro>(
    `SELECT p.id, p.titulo AS nombre, p.ubicacion, i.nombre AS extra
     FROM projects p JOIN institutions i ON i.id = p.institution_id
     WHERE COALESCE(btrim(p.ubicacion), '') <> '' ORDER BY i.nombre, p.titulo`,
  );

  const plan = (regs: Registro[]) => {
    const completar: Array<Registro & { nueva: string }> = [];
    const revisar: Array<Registro & { motivo: string }> = [];
    for (const r of regs) {
      const c = clasificar(r.ubicacion);
      if (c.tipo === 'completar') completar.push({ ...r, nueva: c.nueva });
      if (c.tipo === 'revisar') revisar.push({ ...r, motivo: c.motivo });
    }
    return { completar, revisar };
  };
  const pi = plan(instituciones);
  const pp = plan(proyectos);

  console.log(`\nRevisadas: ${instituciones.length} instituciones y ${proyectos.length} proyectos con ubicación${APLICAR ? '' : '   (MODO EN SECO)'}`);
  imprimir('1. Instituciones con solo departamento → cabecera', pi.completar);
  imprimir('2. Proyectos con solo departamento → cabecera', pp.completar);
  if (pi.revisar.length + pp.revisar.length > 0) {
    imprimir('Para revisar a mano (no se tocan)', [...pi.revisar, ...pp.revisar]);
  }

  // 3. Herencia: proyectos que heredaron el valor ANTERIOR de una institución corregida.
  const herederos = pi.completar.length === 0 ? [] : await selectAll<{ id: string; titulo: string; ubicacion: string; institution_id: string }>(
    `SELECT p.id, p.titulo, p.ubicacion, p.institution_id FROM projects p
     WHERE p.institution_id IN (:ids)
       AND EXISTS (SELECT 1 FROM auditoria a WHERE a.tabla = 'projects' AND a.registro_id = p.id::text AND a.actor = :actor)`,
    { ids: pi.completar.map((i) => i.id), actor: ACTOR_HERENCIA },
  );
  const nuevaPorInst = new Map(pi.completar.map((i) => [i.id, i.nueva]));
  // Los herederos ya están en pp.completar si su valor era solo el departamento; no se duplican.
  const yaPlaneados = new Set(pp.completar.map((p) => p.id));
  const herencia = herederos.filter((h) => !yaPlaneados.has(h.id) && h.ubicacion !== nuevaPorInst.get(h.institution_id));
  console.log(`\n── 3. Herencia desde instituciones corregidas: ${herederos.length} proyecto(s) heredados (${herencia.length} con cambio adicional) ──`);

  let inst = 0;
  let proy = 0;
  if (APLICAR) {
    [inst, proy] = await withTransaction(async (t) => {
      let ni = 0;
      let np = 0;
      for (const i of pi.completar) {
        ni += (await execReturning('UPDATE institutions SET ubicacion = :nueva WHERE id = :id AND ubicacion = :vieja RETURNING id',
          { id: i.id, nueva: i.nueva, vieja: i.ubicacion }, t)).length;
      }
      for (const p of pp.completar) {
        np += (await execReturning('UPDATE projects SET ubicacion = :nueva WHERE id = :id AND ubicacion = :vieja RETURNING id',
          { id: p.id, nueva: p.nueva, vieja: p.ubicacion }, t)).length;
      }
      for (const h of herencia) {
        np += (await execReturning('UPDATE projects SET ubicacion = :nueva WHERE id = :id AND ubicacion = :vieja RETURNING id',
          { id: h.id, nueva: nuevaPorInst.get(h.institution_id), vieja: h.ubicacion }, t)).length;
      }
      return [ni, np];
    }, ACTOR);
  }

  console.log('\n══════════════ RESUMEN ══════════════');
  console.log(`  Instituciones completadas con la cabecera:  ${pi.completar.length}`);
  console.log(`  Proyectos completados con la cabecera:      ${pp.completar.length}`);
  console.log(`  Proyectos actualizados por herencia:        ${herencia.length}`);
  console.log(`  Para revisar a mano:                        ${pi.revisar.length + pp.revisar.length}`);
  console.log(
    APLICAR
      ? `  → Escrito en la BD: ${inst} institución(es), ${proy} proyecto(s) (auditoría: actor = '${ACTOR}')`
      : '  → Nada escrito. Ejecute con --aplicar para guardar.',
  );
  console.log('');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
