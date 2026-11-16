/** API pública del módulo institutions. */
export { institutionsRouter } from './routes/institutions.routes.js';
export {
  institutionsService,
  type InstitutionListDTO,
  type InstitutionDetailDTO,
} from './services/institutions.service.js';
