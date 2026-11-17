/**
 * Inferencia de ubicación ("Municipio, Departamento") a partir de texto: nombre
 * de la institución o título del proyecto. Se usa al importar los reportes del
 * CSS, que no traen ubicación, para que el dashboard no acumule todo en
 * "Sin ubicación".
 *
 * Formato que se guarda (el que ya entienden resolverUbicacion() y el frontend):
 *   "Municipio, Departamento"   p. ej. "Santa Tecla, La Libertad"
 *   "País"                      instituciones de otro país ("Nicaragua")
 * Si el texto solo nombra el departamento se completa con su CABECERA
 * ("Chalatenango" → "Chalatenango, Chalatenango"): es una suposición, pero es la
 * misma que ya se aplicó al histórico (scripts/tmp-municipio-cabecera.ts).
 *
 * Reglas (conservadoras: ante la duda NO se asigna):
 *  - Coincidencia por palabra completa y frase más larga primero
 *    ("ANTIGUO CUSCATLAN" antes que "CUSCATLAN"). Lista curada de municipios: el
 *    catálogo completo produce falsos positivos ("COLEGIO SANTA MARIA" no está en
 *    Santa María, Usulután; "EXTERNADO DE SAN JOSE" no está en San José, La Unión).
 *  - Se descartan topónimos que no son lugares (EXCLUSIONES: "Fe y Alegría",
 *    "San Vicente de Paúl", "Francisco Morazán"…).
 *  - Varios departamentos distintos en el mismo texto → sin asignar.
 *  - País extranjero (no binacional con El Salvador) → el país.
 */
import { normalizeText } from '../../core/database/sql.js';
import { resolverUbicacion, type Departamento } from './geo-el-salvador.js';

/** Cabeceras departamentales de El Salvador. */
export const CABECERAS: Record<Departamento, string> = {
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

/** Sede de la UCA: ubicación por defecto de sus propios proyectos. */
export const UBICACION_UCA = 'Antiguo Cuscatlán, La Libertad';
const ES_UCA = /\b(UCA|UNIVERSIDAD CENTROAMERICANA)\b/;

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

/** Municipios (y localidades conocidas) que aparecen en nombres de instituciones y proyectos. */
// prettier-ignore
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
  { clave: 'LOURDES', municipio: 'Colón', departamento: 'La Libertad' }, // ciudad del municipio de Colón
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
  { clave: 'SAN LUIS DEL CARMEN', municipio: 'San Luis del Carmen', departamento: 'Chalatenango' },
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
const EXCLUSIONES: RegExp[] = [
  /\bFE Y ALEGRIA\b/g, // red educativa, no el municipio de Alegría
  /\bPOR LA PAZ\b/g, // "por la paz", no el departamento
  /\b(GENERAL )?FRANCISCO MORAZAN\b/g, // el prócer
  /\bSAN MIGUEL ARCANGEL\b/g,
  /\bSAN VICENTE DE PAUL\b/g,
  /\bSAN MARTIN DE PORRES\b/g,
  /\b(NUESTRA SENORA|VIRGEN) DE LOURDES\b/g,
  /\bINSTITUTO NACIONAL JOSE SIMEON CANAS\b/g,
];

const PAISES: Record<string, string> = {
  NICARAGUA: 'Nicaragua', GUATEMALA: 'Guatemala', HONDURAS: 'Honduras',
  'COSTA RICA': 'Costa Rica', PANAMA: 'Panamá', MEXICO: 'México',
};
const EXTRANJEROS = /\b(NICARAGUA|GUATEMALA|HONDURAS|COSTA RICA|PANAMA|MEXICO)\b/;
const BINACIONAL = /\bEL SALVADOR\b/;

const CANDIDATOS = [
  ...MUNICIPIOS.map((m) => ({ clave: m.clave, municipio: m.municipio as string | null, departamento: m.departamento })),
  ...DEPARTAMENTOS.map((d) => ({ clave: d.clave, municipio: null as string | null, departamento: d.nombre })),
].sort((a, b) => b.clave.length - a.clave.length); // frase más larga primero

function normalizar(texto: string): string {
  return ` ${normalizeText(texto).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()} `;
}

function conCabecera(departamento: Departamento): string {
  return `${CABECERAS[departamento]}, ${departamento}`;
}

/**
 * Ubicación mencionada en un texto libre (nombre de institución o título de proyecto),
 * o null si no menciona un lugar de forma inequívoca.
 */
export function ubicacionDesdeTexto(textoOriginal: string | null | undefined): string | null {
  if (!textoOriginal?.trim()) return null;
  let texto = normalizar(textoOriginal);
  for (const patron of EXCLUSIONES) texto = texto.replace(patron, ' ');

  const extranjero = EXTRANJEROS.exec(texto)?.[1];
  if (extranjero) return BINACIONAL.test(texto) ? null : PAISES[extranjero]!;

  const hallazgos: Array<{ municipio: string | null; departamento: Departamento }> = [];
  for (const c of CANDIDATOS) {
    const frase = ` ${c.clave} `;
    if (texto.includes(frase)) {
      hallazgos.push(c);
      texto = texto.split(frase).join(' '); // "ANTIGUO CUSCATLAN" no vuelve a contar como "CUSCATLAN"
    }
  }
  if (hallazgos.length === 0) return null;
  if (new Set(hallazgos.map((h) => h.departamento)).size > 1) return null; // ambiguo
  const municipio = hallazgos.find((h) => h.municipio);
  return municipio ? `${municipio.municipio}, ${municipio.departamento}` : conCabecera(hallazgos[0]!.departamento);
}

/**
 * Forma canónica de una ubicación ya escrita (regla de la BD, texto de la institución):
 * "Municipio, Departamento" | "Cabecera, Departamento" | "País". null si no se reconoce.
 *   "Cojutepeque, El Salvador" → "Cojutepeque, Cuscatlán"
 *   "Chalatenango"             → "Chalatenango, Chalatenango"
 */
export function normalizarUbicacion(
  ubicacion: string | null | undefined,
  fk: { municipio?: string | null; departamento?: string | null } = {},
): string | null {
  const u = resolverUbicacion(ubicacion, fk);
  if (u.extranjera) return u.departamento;
  if (!u.departamentoReconocido) return null;
  if (u.municipioConocido) return `${u.municipio}, ${u.departamento}`;
  // "X, Departamento" con X fuera del catálogo: es un dato del usuario, no se reemplaza.
  if (!u.municipio.endsWith(' (sin municipio)')) return null;
  return conCabecera(u.departamento as Departamento);
}

/** Proyectos de la propia UCA sin otra evidencia: sede en Antiguo Cuscatlán. */
export function esInstitucionUca(nombre: string | null | undefined): boolean {
  return Boolean(nombre && ES_UCA.test(normalizar(nombre)));
}
