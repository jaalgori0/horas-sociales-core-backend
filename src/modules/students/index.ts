/**
 * API pública del módulo students. Otros módulos importan SOLO desde aquí,
 * nunca desde archivos internos (controllers/, services/, ...).
 */
export { studentsRouter } from './routes/students.routes.js';
export { studentsService } from './services/students.service.js';
export type { StudentDTO, StudentHoursDTO } from './services/students.service.js';
export { Student, GENEROS, type Genero } from './models/student.model.js';
