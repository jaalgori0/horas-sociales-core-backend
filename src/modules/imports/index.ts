/** API pública del módulo imports (importación masiva de reportes PDF/Excel). */
export { importsRouter } from './routes/imports.routes.js';
export { importsService, type BatchDetailDTO, type BatchSummary } from './services/imports.service.js';
export { parseUploadedFiles, type ParsedFile, type UploadedFile } from './services/file-parser.service.js';
