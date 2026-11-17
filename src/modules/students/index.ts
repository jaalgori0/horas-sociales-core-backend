/**
 * API pública del módulo students. Otros módulos importan SOLO desde aquí,
 * nunca desde archivos internos (controllers/, services/, ...).
 */
export { studentsRouter } from './routes/students.routes.js';
export { studentsService } from './services/students.service.js';
export type { StudentDTO, StudentHoursDTO } from './services/students.service.js';
export {
  studentProfileService,
  HORAS_REQUISITO,
  type StudentProfileDTO,
  type StudentHourMovementDTO,
} from './services/student-profile.service.js';
export { Student, GENEROS, type Genero } from './models/student.model.js';
export {
  studentNameSql,
  studentDisplayName,
  generoToUI,
  generoFromUI,
  type GeneroUI,
} from './student-display.js';
