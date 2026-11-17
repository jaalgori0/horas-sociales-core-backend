/**
 * Inferencia de género a partir del primer nombre (nombres comunes en español).
 *
 * Los reportes del CSS no traen género. Al importar se infiere del nombre para
 * que los gráficos por género no queden en "Sin dato". Es una SUPOSICIÓN: solo
 * se usa para llenar `students.genero` cuando está en NULL; nunca sobrescribe un
 * valor existente ni lo que el estudiante o un usuario editen después.
 *
 * Formatos de entrada:
 *   - `nombres` (si el estudiante los tiene separados): "LOURDES MARIA"
 *   - `nombre_completo` del CSS: "APELLIDO1, APELLIDO2 NOMBRE1 NOMBRE2"
 *       p. ej. "RECINOS, MARROQUIN LOURDES MARIA" → primer nombre LOURDES
 *     Tras la coma la primera palabra es el SEGUNDO apellido (con partículas:
 *     "DE PAZ", "DEL RIO", "DE LA CRUZ"); el primer nombre es la siguiente.
 *
 * Orden de reglas para un nombre:
 *   1. Diccionario de nombres comunes (masculinos / femeninos).
 *   2. Unisex conocidos → sin dato.
 *   3. Termina en A → MUJER, en O → HOMBRE (salvo excepciones conocidas).
 * Si el primer nombre no decide, se prueba el segundo, salvo que contradiga a un
 * primer nombre de género conocido ("JOSE MARIA", "MARIA JOSE" → se usa el primero).
 * Cualquier otro caso → null (queda "Sin dato" para revisión manual).
 */
import { normalizeText } from '../../core/database/sql.js';

export type Genero = 'HOMBRE' | 'MUJER';

// prettier-ignore
const MASCULINOS = [
  'aaron', 'abel', 'abraham', 'adan', 'adolfo', 'adonay', 'adrian', 'agustin', 'alan', 'alberto', 'aldair', 'alejandro',
  'alexander', 'alexis', 'alfonso', 'alfredo', 'allan', 'alvaro', 'amilcar', 'andres', 'angel', 'anibal', 'anthony',
  'antonio', 'ariel', 'armando', 'arnoldo', 'arturo', 'augusto', 'benjamin', 'bernardo', 'boris', 'brandon', 'brayan',
  'bryan', 'byron', 'carlos', 'cesar', 'christian', 'christopher', 'cristian', 'cristopher', 'daniel', 'dany', 'danny',
  'dario', 'david', 'denis', 'dennis', 'dennys', 'diego', 'douglas', 'eddy', 'edgar', 'edgardo', 'eduardo', 'edwin',
  'edward', 'efrain', 'elias', 'emerson', 'emilio', 'emmanuel', 'enrique', 'erick', 'eric', 'ernesto', 'esteban',
  'eugenio', 'ever', 'ezequiel', 'fabricio', 'felipe', 'fernando', 'francisco', 'franklin', 'gabriel', 'gerardo',
  'geovany', 'giovanni', 'gilberto', 'gonzalo', 'guillermo', 'gustavo', 'harold', 'hector', 'henry', 'herbert',
  'hugo', 'ismael', 'ivan', 'jaime', 'jairo', 'javier', 'jefferson', 'jeferson', 'jesus', 'joaquin', 'joel',
  'jonathan', 'jorge', 'jose', 'josue', 'juan', 'julio', 'kenneth', 'kevin', 'leonel', 'leonardo', 'luis', 'manuel',
  'marcel', 'marco', 'marcos', 'mario', 'martin', 'marvin', 'mauricio', 'michael', 'miguel', 'moises', 'nelson',
  'neris', 'nestor', 'noel', 'oscar', 'osmin', 'otoniel', 'pablo', 'pedro', 'rafael', 'ramon', 'raul', 'rene',
  'ricardo', 'roberto', 'rodrigo', 'rolando', 'ronald', 'ruben', 'salvador', 'samuel', 'santiago', 'saul',
  'sebastian', 'sergio', 'stanley', 'steven', 'tomas', 'ulises', 'ulisses', 'uriel', 'victor', 'walter', 'william',
  'wilfredo', 'xavier', 'yonatan', 'zair',
  // Terminan en A pero son masculinos
  'joshua', 'josua', 'bautista', 'luca', 'nicola', 'jeremias', 'zacarias', 'elia', 'isaias',
];

// prettier-ignore
const FEMENINOS = [
  'abigail', 'adriana', 'alejandra', 'alexandra', 'alison', 'allison', 'amparo', 'ana', 'andrea', 'astrid', 'beatriz',
  'belen', 'bessy', 'brenda', 'carmen', 'carolina', 'catherine', 'cecilia', 'claudia', 'consuelo', 'cristina',
  'daniela', 'dayana', 'diana', 'dolores', 'elizabeth', 'elsy', 'emely', 'emily', 'esther', 'evelyn', 'fatima',
  'flor', 'gabriela', 'genesis', 'gisselle', 'glenda', 'gloria', 'grace', 'heidy', 'helen', 'ines', 'ingrid',
  'iris', 'isabel', 'ivette', 'ivett', 'jacqueline', 'jennifer', 'jenny', 'jessica', 'jasmin', 'jazmin', 'judith',
  'julie', 'karen', 'katherine', 'katerine', 'kathy', 'keren', 'kimberly', 'lisseth', 'liseth', 'lissette',
  'lisette', 'lizbeth', 'lourdes', 'luz', 'madeline', 'maribel', 'marisol', 'mercedes', 'michelle', 'milagro',
  'miriam', 'nataly', 'nathaly', 'nicole', 'noemi', 'pilar', 'raquel', 'rocio', 'rosario', 'ruth', 'sarai',
  'sharon', 'sofia', 'socorro', 'stephanie', 'susan', 'yamileth', 'yaneth', 'yesenia', 'yolanda', 'zarah', 'abril',
  'ester', 'ruby', 'mabel', 'marilyn', 'nancy', 'janeth', 'lilian', 'liliana', 'yasmin', 'merary',
  'maria', 'natalia', 'nathalia', 'fernanda', 'valeria', 'camila', 'paola', 'marcela', 'karla', 'carla', 'monica',
  'veronica', 'silvia', 'sandra', 'patricia', 'alicia', 'rebeca', 'sara', 'tatiana', 'vanessa', 'wendy', 'xiomara',
];

/** Se usan para ambos géneros: no se infiere. */
const UNISEX = new Set(['guadalupe', 'trinidad', 'cruz', 'andy', 'dominique', 'sasha', 'noa']);

/** Diccionario. Incluye las excepciones a la regla A/O (JOSHUA → HOMBRE; ROSARIO, AMPARO → MUJER). */
const GENERO_POR_NOMBRE = new Map<string, Genero>([
  ...MASCULINOS.map((n) => [n, 'HOMBRE'] as [string, Genero]),
  ...FEMENINOS.map((n) => [n, 'MUJER'] as [string, Genero]),
]);

/** Partículas que forman parte de un apellido compuesto ("DE LA CRUZ", "DEL RIO"). */
const PARTICULAS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'vda', 'viuda', 'san']);

export interface InferenciaGenero {
  genero: Genero | null;
  /** Nombre(s) usados para decidir (para auditar la decisión). */
  nombre: string | null;
  motivo: string;
}

function palabras(texto: string): string[] {
  return normalizeText(texto)
    .replace(/[^a-zñ\s,]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Género de UN nombre: diccionario → unisex → terminación A/O. */
export function generoDeNombre(nombre: string): { genero: Genero | null; regla: 'diccionario' | 'terminacion' | 'unisex' | 'desconocido' } {
  const clave = normalizeText(nombre);
  const enDiccionario = GENERO_POR_NOMBRE.get(clave);
  if (enDiccionario) return { genero: enDiccionario, regla: 'diccionario' };
  if (UNISEX.has(clave)) return { genero: null, regla: 'unisex' };
  if (clave.length >= 3 && clave.endsWith('a')) return { genero: 'MUJER', regla: 'terminacion' };
  if (clave.length >= 3 && clave.endsWith('o')) return { genero: 'HOMBRE', regla: 'terminacion' };
  return { genero: null, regla: 'desconocido' };
}

/** Decide con primer y (si hace falta) segundo nombre. */
function decidir(primero: string, segundo: string | undefined): InferenciaGenero {
  const p = generoDeNombre(primero);
  if (p.genero) return { genero: p.genero, nombre: primero, motivo: `primer nombre (${p.regla})` };
  if (p.regla === 'unisex') {
    // "GUADALUPE DEL CARMEN": solo el segundo nombre si es de diccionario.
    if (segundo && !PARTICULAS.has(segundo)) {
      const s = generoDeNombre(segundo);
      if (s.genero && s.regla === 'diccionario') return { genero: s.genero, nombre: `${primero} ${segundo}`, motivo: 'segundo nombre (primer nombre unisex)' };
    }
    return { genero: null, nombre: primero, motivo: 'primer nombre unisex' };
  }
  if (!segundo || PARTICULAS.has(segundo)) return { genero: null, nombre: primero, motivo: 'primer nombre desconocido y sin segundo nombre' };
  const s = generoDeNombre(segundo);
  if (s.genero) return { genero: s.genero, nombre: `${primero} ${segundo}`, motivo: `segundo nombre (${s.regla})` };
  return { genero: null, nombre: `${primero} ${segundo}`, motivo: 'ningún nombre reconocido' };
}

/** Nombres de pila a partir de "APELLIDO1, APELLIDO2 NOMBRE1 NOMBRE2". */
function nombresDesdeNombreCompleto(nombreCompleto: string): { nombres: string[]; ambiguo: boolean } | null {
  const coma = nombreCompleto.indexOf(',');
  if (coma === -1) return null;
  const tras = palabras(nombreCompleto.slice(coma + 1));
  if (tras.length === 0) return null;
  if (tras.length === 1) return { nombres: tras, ambiguo: false }; // "PEREZ, JUAN"
  if (tras.length === 2) {
    // "MARROQUIN LOURDES" (apellido2 + nombre) o "JUAN CARLOS" (dos nombres): la 2.ª palabra
    // es un nombre en ambos casos; la 1.ª solo si es un nombre de diccionario.
    return GENERO_POR_NOMBRE.has(tras[0]!) ? { nombres: tras, ambiguo: false } : { nombres: [tras[1]!], ambiguo: true };
  }
  let i = 0;
  while (i < tras.length && PARTICULAS.has(tras[i]!)) i++; // "DE", "DE LA", ...
  i++; // segundo apellido
  const nombres = tras.slice(i);
  return nombres.length > 0 ? { nombres, ambiguo: false } : null;
}

/**
 * Infiere el género de un estudiante. `nombres` (si existe) tiene prioridad sobre
 * `nombre_completo`. Devuelve genero = null cuando no hay certeza razonable.
 */
export function inferirGenero(input: { nombres?: string | null; nombreCompleto?: string | null }): InferenciaGenero {
  if (input.nombres?.trim()) {
    const [primero, segundo] = palabras(input.nombres);
    if (primero) return decidir(primero, segundo);
  }
  if (!input.nombreCompleto?.trim()) return { genero: null, nombre: null, motivo: 'sin nombre' };
  const extraidos = nombresDesdeNombreCompleto(input.nombreCompleto);
  if (!extraidos) return { genero: null, nombre: null, motivo: 'formato de nombre no reconocido (se espera "APELLIDOS, NOMBRES")' };
  const [primero, segundo] = extraidos.nombres;
  const r = decidir(primero!, segundo);
  // Con solo dos palabras tras la coma, únicamente se acepta un nombre de diccionario
  // (la palabra podría ser un apellido terminado en A/O: "PERALTA", "CASTRO").
  if (extraidos.ambiguo && r.genero && generoDeNombre(primero!).regla !== 'diccionario') {
    return { genero: null, nombre: primero!, motivo: 'formato corto: no se distingue apellido de nombre' };
  }
  return r;
}
