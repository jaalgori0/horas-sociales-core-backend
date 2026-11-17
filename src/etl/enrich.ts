/**
 * Proceso de actualización: completa género y ubicación vacíos en el maestro,
 * con las mismas reglas que aplica cada importación confirmada
 * (modules/imports/services/enrichment.service.ts).
 *
 *   pnpm etl:enrich                    → en seco: muestra qué se completaría
 *   pnpm etl:enrich --aplicar          → escribe (una transacción)
 *   pnpm etl:enrich:prod [--aplicar]   → igual, desde dist/ (contenedor de producción)
 *
 * Solo llena valores vacíos. Reversible vía `auditoria` (actor = 'etl:enriquecimiento'):
 *   UPDATE students SET genero = NULL WHERE id IN (
 *     SELECT registro_id::uuid FROM auditoria WHERE tabla = 'students' AND actor = 'etl:enriquecimiento');
 */
import { closeDatabase } from '../core/config/database.js';
import { withTransaction } from '../core/database/sql.js';
import {
  aplicarEnriquecimiento,
  planificarEnriquecimiento,
  type PlanEnriquecimiento,
} from '../modules/imports/services/enrichment.service.js';

const ACTOR = 'etl:enriquecimiento';
const APLICAR = process.argv.includes('--aplicar');
const DETALLE = process.argv.includes('--detalle');

function contarPor<T>(items: T[], clave: (item: T) => string): string {
  const conteo = new Map<string, number>();
  for (const item of items) conteo.set(clave(item), (conteo.get(clave(item)) ?? 0) + 1);
  return [...conteo].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ') || '—';
}

function imprimirPlan(plan: PlanEnriquecimiento): void {
  console.log('\n── Género ──');
  console.log(`  A inferir:   ${plan.generos.length}  (${contarPor(plan.generos, (g) => g.genero)})`);
  console.log(`  Sin inferir: ${plan.generosPendientes.length}  (quedan "Sin dato" para revisión manual)`);
  if (DETALLE) for (const g of plan.generos) console.log(`    ${g.genero.padEnd(6)} ← ${g.nombreCompleto}  (${g.motivo})`);
  for (const g of plan.generosPendientes) console.log(`    ?      ${g.nombreCompleto}  (${g.motivo})`);

  console.log('\n── Instituciones sin ubicación ──');
  console.log(`  A completar: ${plan.instituciones.length}  (por fuente: ${contarPor(plan.instituciones, (i) => i.fuente)})`);
  for (const i of plan.instituciones) console.log(`    ${i.ubicacion.padEnd(34)} [${i.fuente}] ${i.nombre}`);

  console.log('\n── Proyectos sin ubicación ──');
  console.log(`  A completar: ${plan.proyectos.length}  (por fuente: ${contarPor(plan.proyectos, (p) => p.fuente)})`);
  console.log(`  Siguen sin ubicación: ${plan.proyectosPendientes.length}`);
  if (DETALLE) for (const p of plan.proyectos) console.log(`    ${p.ubicacion.padEnd(34)} [${p.fuente}] ${p.nombre}`);
  const porInstitucion = contarPor(plan.proyectosPendientes, (p) => p.institucion);
  if (plan.proyectosPendientes.length > 0) {
    console.log('  Instituciones a agregar en institution_location_rules (proyectos pendientes):');
    for (const linea of porInstitucion.split(' · ').slice(0, 15)) console.log(`    ${linea}`);
  }
}

async function main(): Promise<void> {
  const plan = await planificarEnriquecimiento();
  console.log(APLICAR ? '\nEnriquecimiento del maestro' : '\nEnriquecimiento del maestro   (MODO EN SECO: no se escribe nada)');
  imprimirPlan(plan);

  if (!APLICAR) {
    console.log('\n  → Nada escrito. Ejecute con --aplicar para guardar (--detalle lista cada asignación).\n');
    return;
  }
  // Se replanifica dentro de la transacción: el maestro pudo cambiar desde la lectura.
  const resultado = await withTransaction(async (t) => aplicarEnriquecimiento(await planificarEnriquecimiento(t), t), ACTOR);
  console.log('\n══════════════ ESCRITO ══════════════');
  console.log(`  Géneros:       ${resultado.generos_inferidos.n} (HOMBRE ${resultado.generos_inferidos.hombres} · MUJER ${resultado.generos_inferidos.mujeres})`);
  console.log(`  Instituciones: ${resultado.instituciones_ubicadas.n}`);
  console.log(`  Proyectos:     ${resultado.proyectos_ubicados.n}`);
  console.log(`  Auditoría: actor = '${ACTOR}'\n`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
