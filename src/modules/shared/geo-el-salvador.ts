/**
 * Normalización geográfica de El Salvador: municipio → departamento.
 *
 * `projects.ubicacion` es texto libre ("Santa Tecla, La Libertad", "Soyapango",
 * "usulutan", "Nicaragua"…). Este módulo lo traduce a un departamento canónico
 * para que el mapa del frontend (coordenadasDepartamentos, 14 claves con tilde)
 * siempre reconozca el punto, y a un municipio para los gráficos y el KPI.
 *
 * Catálogo: 14 departamentos y los 262 municipios tradicionales (división previa
 * a la reforma de 2024), que es como se escriben las ubicaciones en la práctica.
 * Las tablas geo_departments/geo_municipalities del esquema siguen vacías: para
 * poblarlas hacen falta los códigos oficiales de DIGESTYC (pendiente). Si un
 * proyecto tiene district_id, la geografía por llave foránea tiene prioridad.
 */
import { normalizeText } from '../../core/database/sql.js';

export const DEPARTAMENTOS = [
  'Ahuachapán', 'Santa Ana', 'Sonsonate', 'Chalatenango', 'La Libertad', 'San Salvador', 'Cuscatlán',
  'La Paz', 'Cabañas', 'San Vicente', 'Usulután', 'San Miguel', 'Morazán', 'La Unión',
] as const;
export type Departamento = (typeof DEPARTAMENTOS)[number];

export const SIN_UBICACION = 'Sin ubicación';

/** Ubicaciones fuera de El Salvador: se muestran tal cual, pero no son municipios ni departamentos. */
export const PAISES_EXTRANJEROS = ['Nicaragua', 'Guatemala', 'Honduras', 'Costa Rica', 'Panamá', 'México'] as const;

const MUNICIPIOS_POR_DEPARTAMENTO: Record<Departamento, readonly string[]> = {
  'Ahuachapán': ['Ahuachapán', 'Apaneca', 'Atiquizaya', 'Concepción de Ataco', 'El Refugio', 'Guaymango', 'Jujutla',
    'San Francisco Menéndez', 'San Lorenzo', 'San Pedro Puxtla', 'Tacuba', 'Turín'],
  'Santa Ana': ['Candelaria de la Frontera', 'Chalchuapa', 'Coatepeque', 'El Congo', 'El Porvenir', 'Masahuat', 'Metapán',
    'San Antonio Pajonal', 'San Sebastián Salitrillo', 'Santa Ana', 'Santa Rosa Guachipilín', 'Santiago de la Frontera',
    'Texistepeque'],
  'Sonsonate': ['Acajutla', 'Armenia', 'Caluco', 'Cuisnahuat', 'Izalco', 'Juayúa', 'Nahuizalco', 'Nahulingo', 'Salcoatitán',
    'San Antonio del Monte', 'San Julián', 'Santa Catarina Masahuat', 'Santa Isabel Ishuatán', 'Santo Domingo de Guzmán',
    'Sonsonate', 'Sonzacate'],
  'Chalatenango': ['Agua Caliente', 'Arcatao', 'Azacualpa', 'Chalatenango', 'Citalá', 'Comalapa', 'Concepción Quezaltepeque',
    'Dulce Nombre de María', 'El Carrizal', 'El Paraíso', 'La Laguna', 'La Palma', 'La Reina', 'Las Vueltas',
    'Nombre de Jesús', 'Nueva Concepción', 'Nueva Trinidad', 'Ojos de Agua', 'Potonico', 'San Antonio de la Cruz',
    'San Antonio Los Ranchos', 'San Fernando', 'San Francisco Lempa', 'San Francisco Morazán', 'San Ignacio',
    'San Isidro Labrador', 'San José Cancasque', 'San José Las Flores', 'San Luis del Carmen', 'San Miguel de Mercedes',
    'San Rafael', 'Santa Rita', 'Tejutla'],
  'La Libertad': ['Antiguo Cuscatlán', 'Chiltiupán', 'Ciudad Arce', 'Colón', 'Comasagua', 'Huizúcar', 'Jayaque', 'Jicalapa',
    'La Libertad', 'Nuevo Cuscatlán', 'Quezaltepeque', 'Sacacoyo', 'San José Villanueva', 'San Juan Opico', 'San Matías',
    'San Pablo Tacachico', 'Santa Tecla', 'Talnique', 'Tamanique', 'Teotepeque', 'Tepecoyo', 'Zaragoza'],
  'San Salvador': ['Aguilares', 'Apopa', 'Ayutuxtepeque', 'Ciudad Delgado', 'Cuscatancingo', 'El Paisnal', 'Guazapa', 'Ilopango',
    'Mejicanos', 'Nejapa', 'Panchimalco', 'Rosario de Mora', 'San Marcos', 'San Martín', 'San Salvador',
    'Santiago Texacuangos', 'Santo Tomás', 'Soyapango', 'Tonacatepeque'],
  'Cuscatlán': ['Candelaria', 'Cojutepeque', 'El Carmen', 'El Rosario', 'Monte San Juan', 'Oratorio de Concepción',
    'San Bartolomé Perulapía', 'San Cristóbal', 'San José Guayabal', 'San Pedro Perulapán', 'San Rafael Cedros', 'San Ramón',
    'Santa Cruz Analquito', 'Santa Cruz Michapa', 'Suchitoto', 'Tenancingo'],
  'La Paz': ['Cuyultitán', 'El Rosario', 'Jerusalén', 'Mercedes La Ceiba', 'Olocuilta', 'Paraíso de Osorio',
    'San Antonio Masahuat', 'San Emigdio', 'San Francisco Chinameca', 'San Juan Nonualco', 'San Juan Talpa',
    'San Juan Tepezontes', 'San Luis La Herradura', 'San Luis Talpa', 'San Miguel Tepezontes', 'San Pedro Masahuat',
    'San Pedro Nonualco', 'San Rafael Obrajuelo', 'Santa María Ostuma', 'Santiago Nonualco', 'Tapalhuaca', 'Zacatecoluca'],
  'Cabañas': ['Cinquera', 'Dolores', 'Guacotecti', 'Ilobasco', 'Jutiapa', 'San Isidro', 'Sensuntepeque', 'Tejutepeque',
    'Victoria'],
  'San Vicente': ['Apastepeque', 'Guadalupe', 'San Cayetano Istepeque', 'San Esteban Catarina', 'San Ildefonso', 'San Lorenzo',
    'San Sebastián', 'San Vicente', 'Santa Clara', 'Santo Domingo', 'Tecoluca', 'Tepetitán', 'Verapaz'],
  'Usulután': ['Alegría', 'Berlín', 'California', 'Concepción Batres', 'El Triunfo', 'Ereguayquín', 'Estanzuelas', 'Jiquilisco',
    'Jucuapa', 'Jucuarán', 'Mercedes Umaña', 'Nueva Granada', 'Ozatlán', 'Puerto El Triunfo', 'San Agustín',
    'San Buenaventura', 'San Dionisio', 'San Francisco Javier', 'Santa Elena', 'Santa María', 'Santiago de María', 'Tecapán',
    'Usulután'],
  'San Miguel': ['Carolina', 'Chapeltique', 'Chinameca', 'Chirilagua', 'Ciudad Barrios', 'Comacarán', 'El Tránsito', 'Lolotique',
    'Moncagua', 'Nueva Guadalupe', 'Nuevo Edén de San Juan', 'Quelepa', 'San Antonio del Mosco', 'San Gerardo', 'San Jorge',
    'San Luis de la Reina', 'San Miguel', 'San Rafael Oriente', 'Sesori', 'Uluazapa'],
  'Morazán': ['Arambala', 'Cacaopera', 'Chilanga', 'Corinto', 'Delicias de Concepción', 'El Divisadero', 'El Rosario',
    'Gualococti', 'Guatajiagua', 'Joateca', 'Jocoaitique', 'Jocoro', 'Lolotiquillo', 'Meanguera', 'Osicala', 'Perquín',
    'San Carlos', 'San Fernando', 'San Francisco Gotera', 'San Isidro', 'San Simón', 'Sensembra', 'Sociedad', 'Torola',
    'Yamabal', 'Yoloaiquín'],
  'La Unión': ['Anamorós', 'Bolívar', 'Concepción de Oriente', 'Conchagua', 'El Carmen', 'El Sauce', 'Intipucá', 'La Unión',
    'Lislique', 'Meanguera del Golfo', 'Nueva Esparta', 'Pasaquina', 'Polorós', 'San Alejo', 'San José',
    'Santa Rosa de Lima', 'Yayantique', 'Yucuaiquín'],
};

/** Nombres populares o antiguos → municipio oficial. */
const ALIAS_MUNICIPIOS: Record<string, { municipio: string; departamento: Departamento }> = {
  'nueva san salvador': { municipio: 'Santa Tecla', departamento: 'La Libertad' },
  'lourdes': { municipio: 'Colón', departamento: 'La Libertad' },
  'lourdes colon': { municipio: 'Colón', departamento: 'La Libertad' },
  'puerto de la libertad': { municipio: 'La Libertad', departamento: 'La Libertad' },
  'delgado': { municipio: 'Ciudad Delgado', departamento: 'San Salvador' },
  'cancasque': { municipio: 'San José Cancasque', departamento: 'Chalatenango' },
  'villa dolores': { municipio: 'Dolores', departamento: 'Cabañas' },
  'san francisco gotera': { municipio: 'San Francisco Gotera', departamento: 'Morazán' },
  'gotera': { municipio: 'San Francisco Gotera', departamento: 'Morazán' },
};

// ─── Índices (clave normalizada sin tildes, como fn_normalize_text) ──────────
const DEPTO_POR_CLAVE = new Map<string, Departamento>(DEPARTAMENTOS.map((d) => [normalizeText(d), d]));
const PAIS_POR_CLAVE = new Map<string, string>([
  ...PAISES_EXTRANJEROS.map((p) => [normalizeText(p), p] as [string, string]),
  ['mexico', 'México'],
  ['panama', 'Panamá'],
]);

/** municipio normalizado → departamentos donde existe (algunos nombres se repiten: "El Rosario", "San Isidro"…). */
const MUNICIPIOS = new Map<string, Array<{ municipio: string; departamento: Departamento }>>();
for (const departamento of DEPARTAMENTOS) {
  for (const municipio of MUNICIPIOS_POR_DEPARTAMENTO[departamento]) {
    const clave = normalizeText(municipio);
    MUNICIPIOS.set(clave, [...(MUNICIPIOS.get(clave) ?? []), { municipio, departamento }]);
  }
}
for (const [clave, valor] of Object.entries(ALIAS_MUNICIPIOS)) {
  if (!MUNICIPIOS.has(clave)) MUNICIPIOS.set(clave, [valor]);
}

export interface UbicacionResuelta {
  /** Clave para el mapa: departamento canónico (14 claves), país extranjero, texto no reconocido o "Sin ubicación". */
  departamento: string;
  /** Clave para gráficos/KPI por municipio. "<Depto> (sin municipio)" si solo se conoce el departamento. */
  municipio: string;
  /** El departamento es uno de los 14 de El Salvador. */
  departamentoReconocido: boolean;
  /** Se conoce un municipio de El Salvador (cuenta para el KPI "Municipios con proyectos"). */
  municipioConocido: boolean;
  /** Ubicación fuera de El Salvador. */
  extranjera: boolean;
}

const sinMunicipio = (d: Departamento) => `${d} (sin municipio)`;

/**
 * Resuelve el texto libre de `projects.ubicacion` (y, si existen, los nombres
 * obtenidos por llave foránea district → municipality → department).
 *
 *   "Antiguo Cuscatlán, La Libertad" → La Libertad / Antiguo Cuscatlán
 *   "soyapango"                      → San Salvador / Soyapango
 *   "Usulutan"                       → Usulután / Usulután (sin municipio)
 *   "El Rosario"                     → no reconocido (existe en 3 departamentos)
 *   "Nicaragua"                      → Nicaragua (extranjera)
 */
export function resolverUbicacion(
  ubicacion: string | null | undefined,
  fk: { municipio?: string | null; departamento?: string | null } = {},
): UbicacionResuelta {
  // 1. Geografía por llave foránea (district_id)
  const deptoFk = fk.departamento ? DEPTO_POR_CLAVE.get(normalizeText(fk.departamento)) : undefined;
  if (deptoFk) {
    return {
      departamento: deptoFk,
      municipio: fk.municipio?.trim() || sinMunicipio(deptoFk),
      departamentoReconocido: true,
      municipioConocido: Boolean(fk.municipio?.trim()),
      extranjera: false,
    };
  }

  const texto = (ubicacion ?? '').trim();
  if (!texto) {
    return { departamento: SIN_UBICACION, municipio: SIN_UBICACION, departamentoReconocido: false, municipioConocido: false, extranjera: false };
  }
  const segmentos = texto.split(',').map((s) => s.trim()).filter(Boolean);
  const claves = segmentos.map(normalizeText);

  // 2. País extranjero
  for (const clave of claves) {
    const pais = PAIS_POR_CLAVE.get(clave);
    if (pais) return { departamento: pais, municipio: pais, departamentoReconocido: false, municipioConocido: false, extranjera: true };
  }

  // 3. Departamento explícito (se busca del último segmento al primero: "Municipio, Departamento")
  let departamento: Departamento | undefined;
  let indiceDepto = -1;
  for (let i = claves.length - 1; i >= 0; i--) {
    const d = DEPTO_POR_CLAVE.get(claves[i]!);
    if (d) { departamento = d; indiceDepto = i; break; }
  }

  // 4. Municipio: el primer segmento que no sea el propio departamento
  const indiceMunicipio = claves.findIndex((_, i) => i !== indiceDepto);
  if (indiceMunicipio >= 0) {
    const candidatos = MUNICIPIOS.get(claves[indiceMunicipio]!) ?? [];
    // Con departamento conocido, el municipio debe pertenecer a él; sin departamento, debe ser único.
    const match = departamento
      ? candidatos.find((c) => c.departamento === departamento)
      : candidatos.length === 1 ? candidatos[0] : undefined;
    if (match) {
      return { departamento: match.departamento, municipio: match.municipio, departamentoReconocido: true, municipioConocido: true, extranjera: false };
    }
    if (departamento) {
      // "X, Departamento" con X fuera del catálogo: se respeta el texto, pero no se da por municipio conocido.
      return { departamento, municipio: segmentos[indiceMunicipio]!, departamentoReconocido: true, municipioConocido: false, extranjera: false };
    }
    // Ni departamento ni municipio único: se devuelve el texto tal cual para que sea visible y se corrija.
    return { departamento: texto, municipio: texto, departamentoReconocido: false, municipioConocido: false, extranjera: false };
  }

  // 5. Solo el departamento (p. ej. "Chalatenango", que es lo que guarda el formulario de creación)
  return {
    departamento: departamento!,
    municipio: sinMunicipio(departamento!),
    departamentoReconocido: true,
    municipioConocido: false,
    extranjera: false,
  };
}

/** Totales del catálogo (para verificación). */
export const CATALOGO_GEO = {
  departamentos: DEPARTAMENTOS.length,
  municipios: DEPARTAMENTOS.reduce((n, d) => n + MUNICIPIOS_POR_DEPARTAMENTO[d].length, 0),
  nombresAmbiguos: [...MUNICIPIOS].filter(([, v]) => v.length > 1).map(([, v]) => `${v[0]!.municipio} (${v.map((x) => x.departamento).join(', ')})`),
};
