/**
 * Normalización geográfica de El Salvador: municipio → departamento.
 *
 * `projects.ubicacion` es texto libre ("Santa Tecla, La Libertad", "Soyapango",
 * "usulutan", "Nicaragua"…). Este módulo lo traduce a un departamento canónico
 * para que el mapa del frontend (coordenadasDepartamentos, 14 claves con tilde)
 * siempre reconozca el punto, y a un municipio para los gráficos y el KPI.
 *
 * Catálogo: 14 departamentos, los 44 municipios oficiales de la reforma de 2024 y sus
 * 262 distritos (los municipios tradicionales). Se reconocen ambos niveles: el distrito
 * ("Santa Tecla", que es como se escriben las ubicaciones en la práctica) y el municipio
 * oficial ("La Libertad Sur"); el resultado indica además a qué municipio oficial pertenece.
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

/**
 * Estructura territorial vigente (Ley Especial para la Reestructuración Municipal, 2024):
 * 44 municipios oficiales, cada uno formado por distritos. Los distritos son los 262
 * municipios tradicionales, que es como se siguen escribiendo las ubicaciones en la
 * práctica ("Santa Tecla, La Libertad"); "La Libertad Sur" es el municipio que los agrupa.
 *
 * Es la ÚNICA fuente del catálogo: MUNICIPIOS_POR_DEPARTAMENTO (los 262) se deriva de aquí.
 * Debe coincidir con src/data/municipios.ts del frontend (que añade las coordenadas).
 */
export const MUNICIPIOS_OFICIALES: Record<Departamento, ReadonlyArray<{ nombre: string; distritos: readonly string[] }>> = {
  'Ahuachapán': [
    { nombre: 'Ahuachapán Norte', distritos: [
      'Atiquizaya', 'El Refugio', 'San Lorenzo', 'Turín',
    ] },
    { nombre: 'Ahuachapán Centro', distritos: [
      'Ahuachapán', 'Apaneca', 'Concepción de Ataco', 'Tacuba',
    ] },
    { nombre: 'Ahuachapán Sur', distritos: [
      'Guaymango', 'Jujutla', 'San Francisco Menéndez', 'San Pedro Puxtla',
    ] },
  ],
  'Santa Ana': [
    { nombre: 'Santa Ana Norte', distritos: [
      'Masahuat', 'Metapán', 'Santa Rosa Guachipilín', 'Texistepeque',
    ] },
    { nombre: 'Santa Ana Centro', distritos: [
      'Santa Ana',
    ] },
    { nombre: 'Santa Ana Este', distritos: [
      'Coatepeque', 'El Congo',
    ] },
    { nombre: 'Santa Ana Oeste', distritos: [
      'Candelaria de la Frontera', 'Chalchuapa', 'El Porvenir', 'San Antonio Pajonal', 'San Sebastián Salitrillo',
      'Santiago de la Frontera',
    ] },
  ],
  'Sonsonate': [
    { nombre: 'Sonsonate Norte', distritos: [
      'Juayúa', 'Nahuizalco', 'Salcoatitán', 'Santa Catarina Masahuat',
    ] },
    { nombre: 'Sonsonate Centro', distritos: [
      'Nahulingo', 'San Antonio del Monte', 'Santo Domingo de Guzmán', 'Sonsonate', 'Sonzacate',
    ] },
    { nombre: 'Sonsonate Este', distritos: [
      'Armenia', 'Caluco', 'Cuisnahuat', 'Izalco', 'San Julián', 'Santa Isabel Ishuatán',
    ] },
    { nombre: 'Sonsonate Oeste', distritos: [
      'Acajutla',
    ] },
  ],
  'Chalatenango': [
    { nombre: 'Chalatenango Norte', distritos: [
      'Citalá', 'La Palma', 'San Ignacio',
    ] },
    { nombre: 'Chalatenango Centro', distritos: [
      'Agua Caliente', 'Dulce Nombre de María', 'El Paraíso', 'La Reina', 'Nueva Concepción', 'San Fernando',
      'San Francisco Morazán', 'San Rafael', 'Santa Rita', 'Tejutla',
    ] },
    { nombre: 'Chalatenango Sur', distritos: [
      'Arcatao', 'Azacualpa', 'Chalatenango', 'Comalapa', 'Concepción Quezaltepeque', 'El Carrizal', 'La Laguna',
      'Las Vueltas', 'Nombre de Jesús', 'Nueva Trinidad', 'Ojos de Agua', 'Potonico', 'San Antonio de la Cruz',
      'San Antonio Los Ranchos', 'San Francisco Lempa', 'San Isidro Labrador', 'San José Cancasque',
      'San José Las Flores', 'San Luis del Carmen', 'San Miguel de Mercedes',
    ] },
  ],
  'La Libertad': [
    { nombre: 'La Libertad Norte', distritos: [
      'Quezaltepeque', 'San Matías', 'San Pablo Tacachico',
    ] },
    { nombre: 'La Libertad Centro', distritos: [
      'Ciudad Arce', 'San Juan Opico',
    ] },
    { nombre: 'La Libertad Oeste', distritos: [
      'Colón', 'Jayaque', 'Sacacoyo', 'Talnique', 'Tepecoyo',
    ] },
    { nombre: 'La Libertad Este', distritos: [
      'Antiguo Cuscatlán', 'Huizúcar', 'Nuevo Cuscatlán', 'San José Villanueva', 'Zaragoza',
    ] },
    { nombre: 'La Libertad Costa', distritos: [
      'Chiltiupán', 'Jicalapa', 'La Libertad', 'Tamanique', 'Teotepeque',
    ] },
    { nombre: 'La Libertad Sur', distritos: [
      'Comasagua', 'Santa Tecla',
    ] },
  ],
  'San Salvador': [
    { nombre: 'San Salvador Norte', distritos: [
      'Aguilares', 'El Paisnal', 'Guazapa',
    ] },
    { nombre: 'San Salvador Oeste', distritos: [
      'Apopa', 'Nejapa',
    ] },
    { nombre: 'San Salvador Este', distritos: [
      'Ilopango', 'San Martín', 'Soyapango', 'Tonacatepeque',
    ] },
    { nombre: 'San Salvador Centro', distritos: [
      'Ayutuxtepeque', 'Ciudad Delgado', 'Cuscatancingo', 'Mejicanos', 'San Salvador',
    ] },
    { nombre: 'San Salvador Sur', distritos: [
      'Panchimalco', 'Rosario de Mora', 'San Marcos', 'Santiago Texacuangos', 'Santo Tomás',
    ] },
  ],
  'Cuscatlán': [
    { nombre: 'Cuscatlán Norte', distritos: [
      'Oratorio de Concepción', 'San Bartolomé Perulapía', 'San José Guayabal', 'San Pedro Perulapán', 'Suchitoto',
    ] },
    { nombre: 'Cuscatlán Sur', distritos: [
      'Candelaria', 'Cojutepeque', 'El Carmen', 'El Rosario', 'Monte San Juan', 'San Cristóbal', 'San Rafael Cedros',
      'San Ramón', 'Santa Cruz Analquito', 'Santa Cruz Michapa', 'Tenancingo',
    ] },
  ],
  'La Paz': [
    { nombre: 'La Paz Oeste', distritos: [
      'Cuyultitán', 'Olocuilta', 'San Francisco Chinameca', 'San Juan Talpa', 'San Luis Talpa', 'San Pedro Masahuat',
      'Tapalhuaca',
    ] },
    { nombre: 'La Paz Centro', distritos: [
      'El Rosario', 'Jerusalén', 'Mercedes La Ceiba', 'Paraíso de Osorio', 'San Antonio Masahuat', 'San Emigdio',
      'San Juan Tepezontes', 'San Luis La Herradura', 'San Miguel Tepezontes', 'San Pedro Nonualco',
      'Santa María Ostuma', 'Santiago Nonualco',
    ] },
    { nombre: 'La Paz Este', distritos: [
      'San Juan Nonualco', 'San Rafael Obrajuelo', 'Zacatecoluca',
    ] },
  ],
  'Cabañas': [
    { nombre: 'Cabañas Oeste', distritos: [
      'Cinquera', 'Ilobasco', 'Jutiapa', 'Tejutepeque',
    ] },
    { nombre: 'Cabañas Este', distritos: [
      'Dolores', 'Guacotecti', 'San Isidro', 'Sensuntepeque', 'Victoria',
    ] },
  ],
  'San Vicente': [
    { nombre: 'San Vicente Norte', distritos: [
      'Apastepeque', 'San Esteban Catarina', 'San Ildefonso', 'San Lorenzo', 'San Sebastián', 'Santa Clara',
      'Santo Domingo',
    ] },
    { nombre: 'San Vicente Sur', distritos: [
      'Guadalupe', 'San Cayetano Istepeque', 'San Vicente', 'Tecoluca', 'Tepetitán', 'Verapaz',
    ] },
  ],
  'Usulután': [
    { nombre: 'Usulután Norte', distritos: [
      'Alegría', 'Berlín', 'El Triunfo', 'Estanzuelas', 'Jucuapa', 'Mercedes Umaña', 'Nueva Granada',
      'San Buenaventura', 'Santiago de María',
    ] },
    { nombre: 'Usulután Este', distritos: [
      'California', 'Concepción Batres', 'Ereguayquín', 'Jucuarán', 'Ozatlán', 'San Dionisio', 'Santa Elena',
      'Santa María', 'Tecapán', 'Usulután',
    ] },
    { nombre: 'Usulután Oeste', distritos: [
      'Jiquilisco', 'Puerto El Triunfo', 'San Agustín', 'San Francisco Javier',
    ] },
  ],
  'San Miguel': [
    { nombre: 'San Miguel Norte', distritos: [
      'Carolina', 'Chapeltique', 'Ciudad Barrios', 'Nuevo Edén de San Juan', 'San Antonio del Mosco', 'San Gerardo',
      'San Luis de la Reina', 'Sesori',
    ] },
    { nombre: 'San Miguel Centro', distritos: [
      'Chirilagua', 'Comacarán', 'Moncagua', 'Quelepa', 'San Miguel', 'Uluazapa',
    ] },
    { nombre: 'San Miguel Oeste', distritos: [
      'Chinameca', 'El Tránsito', 'Lolotique', 'Nueva Guadalupe', 'San Jorge', 'San Rafael Oriente',
    ] },
  ],
  'Morazán': [
    { nombre: 'Morazán Norte', distritos: [
      'Arambala', 'Cacaopera', 'Corinto', 'El Rosario', 'Joateca', 'Jocoaitique', 'Meanguera', 'Perquín',
      'San Fernando', 'San Isidro', 'Torola',
    ] },
    { nombre: 'Morazán Sur', distritos: [
      'Chilanga', 'Delicias de Concepción', 'El Divisadero', 'Gualococti', 'Guatajiagua', 'Jocoro', 'Lolotiquillo',
      'Osicala', 'San Carlos', 'San Francisco Gotera', 'San Simón', 'Sensembra', 'Sociedad', 'Yamabal', 'Yoloaiquín',
    ] },
  ],
  'La Unión': [
    { nombre: 'La Unión Norte', distritos: [
      'Anamorós', 'Bolívar', 'Concepción de Oriente', 'El Sauce', 'Lislique', 'Nueva Esparta', 'Pasaquina', 'Polorós',
      'San José', 'Santa Rosa de Lima',
    ] },
    { nombre: 'La Unión Sur', distritos: [
      'Conchagua', 'El Carmen', 'Intipucá', 'La Unión', 'Meanguera del Golfo', 'San Alejo', 'Yayantique', 'Yucuaiquín',
    ] },
  ],
};

/** Los 262 distritos (municipios tradicionales) por departamento, derivados del catálogo oficial. */
const MUNICIPIOS_POR_DEPARTAMENTO = {} as Record<Departamento, readonly string[]>;
for (const d of DEPARTAMENTOS) MUNICIPIOS_POR_DEPARTAMENTO[d] = MUNICIPIOS_OFICIALES[d].flatMap((m) => m.distritos);

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

type EntradaMunicipio = {
  /** Nombre que se devuelve como `municipio`: el distrito, o el municipio oficial si se escribió así. */
  municipio: string;
  departamento: Departamento;
  /** Municipio oficial (2024) al que corresponde. */
  oficial: string;
};

/** "departamento|distrito" normalizado → municipio oficial que lo contiene. */
const OFICIAL_POR_DISTRITO = new Map<string, string>();
for (const departamento of DEPARTAMENTOS) {
  for (const { nombre, distritos } of MUNICIPIOS_OFICIALES[departamento]) {
    for (const distrito of distritos) OFICIAL_POR_DISTRITO.set(`${normalizeText(departamento)}|${normalizeText(distrito)}`, nombre);
  }
}
const oficialDe = (municipio: string, departamento: Departamento) =>
  OFICIAL_POR_DISTRITO.get(`${normalizeText(departamento)}|${normalizeText(municipio)}`);

/**
 * Nombre normalizado → lugares donde existe. Incluye los 262 distritos (algunos se repiten
 * entre departamentos: "El Rosario", "San Isidro"…), los 44 municipios oficiales y los alias.
 */
const MUNICIPIOS = new Map<string, EntradaMunicipio[]>();
const indexar = (clave: string, entrada: EntradaMunicipio) => {
  const previas = MUNICIPIOS.get(clave) ?? [];
  if (!previas.some((e) => e.departamento === entrada.departamento)) MUNICIPIOS.set(clave, [...previas, entrada]);
};
for (const departamento of DEPARTAMENTOS) {
  for (const { nombre, distritos } of MUNICIPIOS_OFICIALES[departamento]) {
    for (const distrito of distritos) indexar(normalizeText(distrito), { municipio: distrito, departamento, oficial: nombre });
    indexar(normalizeText(nombre), { municipio: nombre, departamento, oficial: nombre });
  }
}
for (const [clave, { municipio, departamento }] of Object.entries(ALIAS_MUNICIPIOS)) {
  if (!MUNICIPIOS.has(clave)) MUNICIPIOS.set(clave, [{ municipio, departamento, oficial: oficialDe(municipio, departamento)! }]);
}

/** Prefijos que no forman parte del nombre: "Distrito de Santa Tecla", "Municipio de La Libertad Sur". */
const PREFIJO_TERRITORIAL = /^(distrito|municipio)\s+(de\s+)?/;

export interface UbicacionResuelta {
  /** Clave para el mapa: departamento canónico (14 claves), país extranjero, texto no reconocido o "Sin ubicación". */
  departamento: string;
  /** Clave para gráficos/KPI por municipio. "<Depto> (sin municipio)" si solo se conoce el departamento. */
  municipio: string;
  /** El departamento es uno de los 14 de El Salvador. */
  departamentoReconocido: boolean;
  /** Se conoce un municipio de El Salvador (cuenta para el KPI "Municipios con proyectos"). */
  municipioConocido: boolean;
  /**
   * Municipio oficial de la reforma de 2024 ("La Libertad Sur") al que pertenece el lugar,
   * tanto si se escribió el distrito ("Santa Tecla") como el municipio oficial. null si no se conoce.
   */
  municipioOficial: string | null;
  /** Ubicación fuera de El Salvador. */
  extranjera: boolean;
}

const sinMunicipio = (d: Departamento) => `${d} (sin municipio)`;

/**
 * Resuelve el texto libre de `projects.ubicacion` (y, si existen, los nombres
 * obtenidos por llave foránea district → municipality → department).
 *
 *   "Antiguo Cuscatlán, La Libertad" → La Libertad / Antiguo Cuscatlán (oficial: La Libertad Este)
 *   "soyapango"                      → San Salvador / Soyapango (oficial: San Salvador Este)
 *   "La Libertad Sur"                → La Libertad / La Libertad Sur (municipio oficial de 2024)
 *   "Santa Tecla, La Libertad Sur, La Libertad" → La Libertad / Santa Tecla (oficial: La Libertad Sur)
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
    const municipioFk = fk.municipio?.trim();
    return {
      departamento: deptoFk,
      municipio: municipioFk || sinMunicipio(deptoFk),
      departamentoReconocido: true,
      municipioConocido: Boolean(municipioFk),
      municipioOficial: municipioFk ? (MUNICIPIOS.get(normalizeText(municipioFk)) ?? []).find((e) => e.departamento === deptoFk)?.oficial ?? null : null,
      extranjera: false,
    };
  }

  const texto = (ubicacion ?? '').trim();
  if (!texto) {
    return {
      departamento: SIN_UBICACION, municipio: SIN_UBICACION, departamentoReconocido: false, municipioConocido: false,
      municipioOficial: null, extranjera: false,
    };
  }
  const segmentos = texto.split(',').map((s) => s.trim()).filter(Boolean);
  const claves = segmentos.map(normalizeText);

  // 2. País extranjero
  for (const clave of claves) {
    const pais = PAIS_POR_CLAVE.get(clave);
    if (pais) {
      return { departamento: pais, municipio: pais, departamentoReconocido: false, municipioConocido: false, municipioOficial: null, extranjera: true };
    }
  }

  // 3. Departamento explícito (se busca del último segmento al primero: "Municipio, Departamento")
  let departamento: Departamento | undefined;
  let indiceDepto = -1;
  for (let i = claves.length - 1; i >= 0; i--) {
    const d = DEPTO_POR_CLAVE.get(claves[i]!);
    if (d) { departamento = d; indiceDepto = i; break; }
  }

  // 4. Municipio: el primer segmento (que no sea el departamento) que esté en el catálogo, sea
  //    distrito o municipio oficial. Así "Santa Tecla, La Libertad Sur, La Libertad" se queda
  //    con el distrito (más preciso) y "La Libertad Sur, La Libertad" con el municipio oficial.
  const indicesLugar = claves.map((_, i) => i).filter((i) => i !== indiceDepto);
  if (indicesLugar.length > 0) {
    for (const i of indicesLugar) {
      const candidatos = MUNICIPIOS.get(claves[i]!.replace(PREFIJO_TERRITORIAL, '')) ?? [];
      // Con departamento conocido, el lugar debe pertenecer a él; sin departamento, debe ser único.
      const match = departamento
        ? candidatos.find((c) => c.departamento === departamento)
        : candidatos.length === 1 ? candidatos[0] : undefined;
      if (match) {
        return {
          departamento: match.departamento, municipio: match.municipio, departamentoReconocido: true, municipioConocido: true,
          municipioOficial: match.oficial, extranjera: false,
        };
      }
    }
    const indiceMunicipio = indicesLugar[0]!;
    if (departamento) {
      // "X, Departamento" con X fuera del catálogo: se respeta el texto, pero no se da por municipio conocido.
      return {
        departamento, municipio: segmentos[indiceMunicipio]!, departamentoReconocido: true, municipioConocido: false,
        municipioOficial: null, extranjera: false,
      };
    }
    // Ni departamento ni municipio único: se devuelve el texto tal cual para que sea visible y se corrija.
    return {
      departamento: texto, municipio: texto, departamentoReconocido: false, municipioConocido: false,
      municipioOficial: null, extranjera: false,
    };
  }

  // 5. Solo el departamento (p. ej. "Chalatenango", que es lo que guarda el formulario de creación)
  return {
    departamento: departamento!,
    municipio: sinMunicipio(departamento!),
    departamentoReconocido: true,
    municipioConocido: false,
    municipioOficial: null,
    extranjera: false,
  };
}

/** Totales del catálogo (para verificación). */
export const CATALOGO_GEO = {
  departamentos: DEPARTAMENTOS.length,
  /** Municipios tradicionales (hoy distritos). Se mantiene el nombre por compatibilidad. */
  municipios: DEPARTAMENTOS.reduce((n, d) => n + MUNICIPIOS_POR_DEPARTAMENTO[d].length, 0),
  municipiosOficiales: DEPARTAMENTOS.reduce((n, d) => n + MUNICIPIOS_OFICIALES[d].length, 0),
  nombresAmbiguos: [...MUNICIPIOS].filter(([, v]) => v.length > 1).map(([, v]) => `${v[0]!.municipio} (${v.map((x) => x.departamento).join(', ')})`),
};
