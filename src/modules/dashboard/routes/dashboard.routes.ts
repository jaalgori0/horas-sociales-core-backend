/**
 * Rutas del dashboard. Montadas en `${API_PREFIX}/dashboard` (solo lectura).
 *
 *   GET /summary                 KPIs, proyectos por estado, tendencia y género
 *   GET /map-markers             Marcadores del mapa (tabla map_markers)
 *   GET /carrera-anio            Por carrera y año (?metrica=estudiantes|participaciones)
 *   GET /genero                  Participantes por género (+ sinDato) (?facultyId)
 *   GET /tendencia-anual         Estudiantes, proyectos y horas por año
 *   GET /estudiantes-municipio   Estudiantes por municipio de ejecución
 *   GET /proyectos-municipio     Proyectos (y activos) por municipio
 *   GET /metricas-institucion    Métricas por institución (?limit)
 *   GET /tabla-institucion       Tabla detallada por institución (?limit)
 *   GET /estudiantes-multiproyecto  Estudiantes con 2+ proyectos y cuántos tiene cada uno
 *
 * Además, `GET /students/genero-municipio` (género por departamento, para el
 * mapa) se monta en core/server/routes.ts antes del router de students.
 */
import express from 'express';
import { dashboardController } from '../controllers/dashboard.controller.js';

export const dashboardRouter = express.Router();

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
