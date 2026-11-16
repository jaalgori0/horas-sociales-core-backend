/**
 * Catálogo académico oficial (migración 003): facultades y carreras.
 * Solo lectura desde la API: el catálogo se cambia con migraciones.
 */
import { AppError } from '../../../core/errors/app-error.js';
import { selectAll, selectOne } from '../../../core/database/sql.js';
import type { ListCareersQuery, ListFacultiesQuery } from '../schemas/catalog.schemas.js';

export interface FacultyDTO {
  id: string;
  nombre: string;
  activo: boolean;
  totalCarreras: number;
}

export interface CareerDTO {
  id: string;
  nombre: string;
  /** snake_case: lo exige el frontend (CareerResponse.faculty_id). */
  faculty_id: string;
  facultyId: string;
  facultad: string;
  activo: boolean;
}

const FACULTY_SELECT = `
  SELECT f.id, f.nombre, f.activo,
         (SELECT count(*) FROM careers c WHERE c.faculty_id = f.id AND c.activo)::int AS "totalCarreras"
  FROM faculties f`;

const CAREER_SELECT = `
  SELECT c.id, c.nombre, c.faculty_id, c.faculty_id AS "facultyId", f.nombre AS facultad, c.activo
  FROM careers c
  JOIN faculties f ON f.id = c.faculty_id`;

export const catalogService = {
  async listFaculties(query: ListFacultiesQuery): Promise<FacultyDTO[]> {
    return selectAll<FacultyDTO>(
      `${FACULTY_SELECT}
       WHERE (:incluirInactivas OR f.activo)
       ORDER BY f.nombre`,
      { incluirInactivas: query.incluirInactivas },
    );
  },

  async getFaculty(id: string): Promise<FacultyDTO & { carreras: CareerDTO[] }> {
    const faculty = await selectOne<FacultyDTO>(`${FACULTY_SELECT} WHERE f.id = :id`, { id });
    if (!faculty) throw AppError.notFound('Facultad no encontrada');
    const carreras = await selectAll<CareerDTO>(`${CAREER_SELECT} WHERE c.faculty_id = :id ORDER BY c.nombre`, { id });
    return { ...faculty, carreras };
  },

  async listCareers(query: ListCareersQuery): Promise<CareerDTO[]> {
    return selectAll<CareerDTO>(
      `${CAREER_SELECT}
       WHERE (CAST(:facultyId AS uuid) IS NULL OR c.faculty_id = CAST(:facultyId AS uuid))
         AND (:incluirInactivas OR c.activo)
       ORDER BY f.nombre, c.nombre`,
      { facultyId: query.facultyId ?? null, incluirInactivas: query.incluirInactivas },
    );
  },

  async getCareer(id: string): Promise<CareerDTO> {
    const career = await selectOne<CareerDTO>(`${CAREER_SELECT} WHERE c.id = :id`, { id });
    if (!career) throw AppError.notFound('Carrera no encontrada');
    return career;
  },
};
