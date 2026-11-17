# Despliegue con Docker

Levanta la aplicación completa (PostgreSQL 16 + API + frontend con Nginx) en un solo equipo.

## Requisitos

- Docker Desktop (Windows/macOS) o Docker Engine con el plugin Compose (Linux).

## Instalación

1. Clone ambos repositorios en una misma carpeta:

   ```
   horas-sociales/
   ├── horas-sociales-core-backend/
   └── Proyecto-de-horas-sociales-frontend/
   ```

2. Copie `deploy/docker-compose.yml` y `deploy/.env.example` a esa carpeta padre y renombre `.env.example` a `.env`.
3. En `.env`, reemplace cada valor `CAMBIAR`. El propio archivo explica cómo generar valores aleatorios.
4. Desde la carpeta padre:

   ```
   docker compose up -d --build
   ```

5. Abra <http://localhost:8080>. Inicie sesión con `oarias@uca.edu.sv` / `1234abc` y **cambie la contraseña**.

La base de datos arranca vacía; los estudiantes, proyectos e instituciones se cargan desde **Importar** con los reportes del CSS.

## Operación

| Acción | Comando (en la carpeta padre) |
|---|---|
| Ver estado | `docker compose ps` |
| Ver logs del backend | `docker compose logs -f backend` |
| Detener (conserva los datos) | `docker compose down` |
| Actualizar tras un `git pull` | `docker compose up -d --build` |
| Respaldo de la base de datos | `docker compose exec db pg_dump -U horas_sociales horas_sociales > respaldo.sql` |

`docker compose down -v` **borra la base de datos**. Úselo solo si quiere empezar de cero.

Guarde una copia del `.env` fuera del equipo: sin `DUI_ENCRYPTION_KEY` los DUI cifrados no se pueden recuperar.
