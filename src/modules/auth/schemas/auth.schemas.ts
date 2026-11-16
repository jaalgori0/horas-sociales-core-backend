/** Contratos de auth: RegisterPayload / LoginPayload del frontend. */
import { z } from 'zod';

const correo = z.string().trim().toLowerCase().email('Correo inválido').max(254);

export const registerSchema = z.object({
  nombre: z.string().trim().min(1, 'Requerido').max(120),
  apellido: z.string().trim().min(1, 'Requerido').max(120),
  correo,
  password: z
    .string()
    .min(8, 'La contraseña debe tener al menos 8 caracteres')
    .max(128, 'La contraseña no puede superar 128 caracteres'),
});

export const loginSchema = z.object({
  correo,
  password: z.string().min(1, 'Requerido').max(128),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
