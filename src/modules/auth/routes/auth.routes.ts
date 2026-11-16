/**
 * Rutas de autenticación. Montadas en `${API_PREFIX}/auth`.
 *
 *   POST /register   Crea un usuario (rol AUTH_REGISTER_ROLE; 403 si AUTH_ALLOW_REGISTER=false)
 *   POST /login      Verifica credenciales y emite el token de sesión ({ ...usuario, token, expiresAt });
 *                    401 genérico; 429 tras 5 fallos en 15 min
 */
import express from 'express';
import { authController } from '../controllers/auth.controller.js';

export const authRouter = express.Router();

authRouter.post('/register', authController.register);
authRouter.post('/login', authController.login);
