/**
 * Enriquecimiento del maestro tras una importación: completa los datos que los
 * reportes del CSS NO traen.
 *
 *   • students.genero          inferido del primer nombre (shared/genero-por-nombre.ts)
 *   • institutions.ubicacion   regla institution_location_rules (codigo_css) →
 *                              topónimo en el nombre → sede UCA
 *   • projects.ubicacion       topónimo en el título → ubicación de su institución → sede UCA
 *
 * Solo se llenan valores vacíos (genero NULL, ubicación vacía y sin district_id):
 * nunca se sobrescribe lo que exista ni lo que un usuario edite. Se recorre TODO el
 * maestro, no solo el lote: así, reimportar (o `pnpm etl:enrich`) rellena también
 * los registros antiguos que quedaron vacíos. Cada UPDATE queda en `auditoria`
 * con el actor de la transacción (import:<lote>, usuario o etl:enriquecimiento).
 */
import type { Transaction } from 'sequelize';
import { execReturning, selectAll } from '../../../core/database/sql.js';
import { inferirGenero, type Genero } from '../../shared/genero-por-nombre.js';
import {
  UBICACION_UCA,
  esInstitucionUca,
  normalizarUbicacion,
  ubicacionDesdeTexto,
} from '../../shared/ubicacion-por-texto.js';

export interface AsignacionGenero {
  id: string;
  nombreCompleto: string;
  genero: Genero;
  motivo: string;
}

export interface AsignacionUbicacion {
  id: string;
  nombre: string;
  ubicacion: string;
  fuente: 'regla' | 'nombre' | 'titulo' | 'institucion' | 'uca';
}

export interface PlanEnriquecimiento {
  generos: AsignacionGenero[];
  /** Estudiantes con género NULL que no se pudieron inferir (revisión manual). */
  generosPendientes: Array<{ id: string; nombreCompleto: string; motivo: string }>;
  instituciones: AsignacionUbicacion[];
  proyectos: AsignacionUbicacion[];
  /** Proyectos que siguen sin ubicación tras aplicar todas las reglas. */
  proyectosPendientes: Array<{ id: string; nombre: string; institucion: string }>;
}

interface FilaInstitucion {
  id: string;
  nombre: string;
  ubicacion: string | null;
  regla: string | null;
  municipio_fk: string | null;
  departamento_fk: string | null;
}

interface FilaProyecto {
  id: string;
  titulo: string;
  institution_id: string;
  institucion: string;
}

const VACIO = (col: string) => `COALESCE(btrim(${col}), '') = ''`;

/** Calcula qué se completaría, sin escribir nada. */
export async function planificarEnriquecimiento(t?: Transaction): Promise<PlanEnriquecimiento> {
  // ── Género ──
  const estudiantes = await selectAll<{ id: string; nombres: string | null; nombre_completo: string }>(
    'SELECT id, nombres, nombre_completo FROM students WHERE genero IS NULL ORDER BY nombre_completo',
    {},
    t,
  );
  const generos: AsignacionGenero[] = [];
  const generosPendientes: PlanEnriquecimiento['generosPendientes'] = [];
  for (const s of estudiantes) {
    const r = inferirGenero({ nombres: s.nombres, nombreCompleto: s.nombre_completo });
    if (r.genero) generos.push({ id: s.id, nombreCompleto: s.nombre_completo, genero: r.genero, motivo: r.motivo });
    else generosPendientes.push({ id: s.id, nombreCompleto: s.nombre_completo, motivo: r.motivo });
  }

  // ── Instituciones ──
  const filasInst = await selectAll<FilaInstitucion>(
    `SELECT i.id, i.nombre, i.ubicacion, r.ubicacion AS regla,
            gm.nombre AS municipio_fk, gdep.nombre AS departamento_fk
     FROM institutions i
     LEFT JOIN institution_location_rules r ON r.codigo_css = i.codigo_css
     LEFT JOIN geo_districts gd      ON gd.id = i.district_id
     LEFT JOIN geo_municipalities gm ON gm.id = gd.municipality_id
     LEFT JOIN geo_departments gdep  ON gdep.id = gm.department_id
     ORDER BY i.nombre`,
    {},
    t,
  );
  /** Ubicación efectiva (normalizada) de cada institución tras el plan: la heredan sus proyectos. */
  const ubicacionInstitucion = new Map<string, string | null>();
  const instituciones: AsignacionUbicacion[] = [];
  for (const i of filasInst) {
    const tieneUbicacion = Boolean(i.ubicacion?.trim()) || Boolean(i.departamento_fk);
    if (tieneUbicacion) {
      ubicacionInstitucion.set(i.id, normalizarUbicacion(i.ubicacion, { municipio: i.municipio_fk, departamento: i.departamento_fk }));
      continue;
    }
    const porRegla = normalizarUbicacion(i.regla);
    const porNombre = porRegla ? null : ubicacionDesdeTexto(i.nombre);
    const porUca = porRegla || porNombre ? null : esInstitucionUca(i.nombre) ? UBICACION_UCA : null;
    const ubicacion = porRegla ?? porNombre ?? porUca;
    ubicacionInstitucion.set(i.id, ubicacion);
    if (ubicacion) {
      instituciones.push({ id: i.id, nombre: i.nombre, ubicacion, fuente: porRegla ? 'regla' : porNombre ? 'nombre' : 'uca' });
    }
  }

  // ── Proyectos ──
  const filasProy = await selectAll<FilaProyecto>(
    `SELECT p.id, p.titulo, p.institution_id, i.nombre AS institucion
     FROM projects p JOIN institutions i ON i.id = p.institution_id
     WHERE ${VACIO('p.ubicacion')} AND p.district_id IS NULL
     ORDER BY i.nombre, p.titulo`,
    {},
    t,
  );
  const proyectos: AsignacionUbicacion[] = [];
  const proyectosPendientes: PlanEnriquecimiento['proyectosPendientes'] = [];
  for (const p of filasProy) {
    const porTitulo = ubicacionDesdeTexto(p.titulo);
    const porInstitucion = porTitulo ? null : (ubicacionInstitucion.get(p.institution_id) ?? null);
    const ubicacion = porTitulo ?? porInstitucion;
    if (ubicacion) {
      proyectos.push({ id: p.id, nombre: p.titulo, ubicacion, fuente: porTitulo ? 'titulo' : 'institucion' });
    } else {
      proyectosPendientes.push({ id: p.id, nombre: p.titulo, institucion: p.institucion });
    }
  }

  return { generos, generosPendientes, instituciones, proyectos, proyectosPendientes };
}

/** Agrupa ids por valor para escribir con un UPDATE por valor distinto. */
function agrupar<T extends { id: string }>(items: T[], valor: (item: T) => string): Map<string, string[]> {
  const grupos = new Map<string, string[]>();
  for (const item of items) grupos.set(valor(item), [...(grupos.get(valor(item)) ?? []), item.id]);
  return grupos;
}

async function actualizarPorGrupos(
  sql: string,
  grupos: Map<string, string[]>,
  t: Transaction,
): Promise<number> {
  let total = 0;
  for (const [valor, ids] of grupos) {
    total += (await execReturning<{ id: string }>(sql, { valor, ids }, t)).length;
  }
  return total;
}

export type ResultadoEnriquecimiento = Record<
  'generos_inferidos' | 'instituciones_ubicadas' | 'proyectos_ubicados',
  Record<string, number>
>;

/** Escribe el plan. Cada UPDATE vuelve a exigir que el campo siga vacío (no pisa cambios concurrentes). */
export async function aplicarEnriquecimiento(plan: PlanEnriquecimiento, t: Transaction): Promise<ResultadoEnriquecimiento> {
  const hombres = await actualizarPorGrupos(
    'UPDATE students SET genero = :valor WHERE id IN (:ids) AND genero IS NULL RETURNING id',
    agrupar(plan.generos.filter((g) => g.genero === 'HOMBRE'), (g) => g.genero),
    t,
  );
  const mujeres = await actualizarPorGrupos(
    'UPDATE students SET genero = :valor WHERE id IN (:ids) AND genero IS NULL RETURNING id',
    agrupar(plan.generos.filter((g) => g.genero === 'MUJER'), (g) => g.genero),
    t,
  );
  const instituciones = await actualizarPorGrupos(
    `UPDATE institutions SET ubicacion = :valor WHERE id IN (:ids) AND ${VACIO('ubicacion')} AND district_id IS NULL RETURNING id`,
    agrupar(plan.instituciones, (i) => i.ubicacion),
    t,
  );
  const proyectos = await actualizarPorGrupos(
    `UPDATE projects SET ubicacion = :valor WHERE id IN (:ids) AND ${VACIO('ubicacion')} AND district_id IS NULL RETURNING id`,
    agrupar(plan.proyectos, (p) => p.ubicacion),
    t,
  );
  return {
    generos_inferidos: { n: hombres + mujeres, hombres, mujeres, pendientes: plan.generosPendientes.length },
    instituciones_ubicadas: { n: instituciones },
    proyectos_ubicados: { n: proyectos, pendientes: plan.proyectosPendientes.length },
  };
}

/** Planifica y aplica en la misma transacción. */
export async function enriquecerMaestro(t: Transaction): Promise<ResultadoEnriquecimiento> {
  return aplicarEnriquecimiento(await planificarEnriquecimiento(t), t);
}
