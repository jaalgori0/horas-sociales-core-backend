/**
 * Rutas del dashboard. Montadas en `${API_PREFIX}/dashboard` (solo lectura).
 *
 * Filtro general `?anio=<año>|todos` (criterio CSS: proyectos iniciados, inscripciones
 * asignadas y horas registradas en el año). Donde se indica [año], sin el parámetro =
 * todos los años; en /summary, sin el parámetro = el año más reciente con participaciones.
 *
 *   GET /anios                   Años con datos y año por defecto del selector general
 *   GET /summary                 KPIs, proyectos por estado, tendencia (sin filtrar) y género [año]
 *   GET /conciliacion            Excel CSS (alumnos por proyecto) vs. inscripciones cargadas (?anio)
 *   GET /map-markers             Marcadores del mapa (tabla map_markers)
 *   GET /carrera-anio            Por carrera y año, más `todos` (?metrica=estudiantes|participaciones)
 *   GET /genero                  Participantes por género (+ sinDato) (?facultyId) [año]
 *   GET /tendencia-anual         Estudiantes, proyectos y horas por año
 *   GET /estudiantes-municipio   Estudiantes por municipio de ejecución [año]
 *   GET /proyectos-municipio     Proyectos (y activos, estado actual) por municipio [año]
 *   GET /metricas-institucion    Métricas por institución (?limit) [año]
 *   GET /tabla-institucion       Tabla detallada por institución (?limit) [año]
 *   GET /estudiantes-multiproyecto  Estudiantes con 2+ proyectos y cuántos tiene cada uno [año]
 *   GET /completaron-600         Participantes del año que completaron 600 h (?anio, ?facultyId)
 *
 * Además, `GET /students/genero-municipio` (género por departamento, para el
 * mapa) se monta en core/server/routes.ts antes del router de students.
 */
import express from 'express';
import { dashboardController } from '../controllers/dashboard.controller.js';

export const dashboardRouter = express.Router();

dashboardRouter.get('/anios', dashboardController.anios);
dashboardRouter.get('/summary', dashboardController.summary);
dashboardRouter.get('/map-markers', dashboardController.mapMarkers);
dashboardRouter.get('/carrera-anio', dashboardController.carreraAnio);
dashboardRouter.get('/genero', dashboardController.genero);
dashboardRouter.get('/tendencia-anual', dashboardController.tendenciaAnual);
dashboardRouter.get('/estudiantes-municipio', dashboardController.estudiantesMunicipio);
dashboardRouter.get('/proyectos-municipio', dashboardController.proyectosMunicipio);
dashboardRouter.get('/metricas-institucion', dashboardController.tablaInstitucion);
dashboardRouter.get('/tabla-institucion', dashboardController.tablaInstitucion);
dashboardRouter.get('/estudiantes-multiproyecto', dashboardController.estudiantesMultiProyecto);
dashboardRouter.get('/completaron-600', dashboardController.completaron600);
dashboardRouter.get('/conciliacion', dashboardController.conciliacion);
