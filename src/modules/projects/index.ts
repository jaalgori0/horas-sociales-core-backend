/** API pública del módulo projects (incluye inscripciones). */
export { projectsRouter } from './routes/projects.routes.js';
export { projectsService } from './services/projects.service.js';
export { enrollmentsService } from './services/enrollments.service.js';
export { startProjectStatusSync } from './services/project-status.service.js';
export type {
  ProjectListDTO,
  ProjectDetailDTO,
  ProjectMapDTO,
  ProjectStudentDTO,
  HourMovementDTO,
} from './services/project.queries.js';
