/**
 * Mensajes de Zod en español para los casos genéricos. Los mensajes
 * específicos definidos en cada esquema tienen prioridad sobre este mapa.
 * Se registra una sola vez al crear la aplicación (core/server/app.ts).
 */
import { z, ZodIssueCode, type ZodErrorMap } from 'zod';

const spanishErrorMap: ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === 'undefined') return { message: 'Requerido' };
      return { message: `Tipo inválido: se esperaba ${issue.expected} y se recibió ${issue.received}` };
    case ZodIssueCode.unrecognized_keys:
      return { message: `Campos no permitidos: ${issue.keys.join(', ')}` };
    case ZodIssueCode.invalid_enum_value:
      return { message: `Valor inválido. Opciones: ${issue.options.join(', ')}` };
    case ZodIssueCode.invalid_string:
      if (issue.validation === 'uuid') return { message: 'Debe ser un UUID válido' };
      return { message: ctx.defaultError };
    case ZodIssueCode.too_small:
      return { message: `Debe ser mayor o igual a ${String(issue.minimum)}` };
    case ZodIssueCode.too_big:
      return { message: `Debe ser menor o igual a ${String(issue.maximum)}` };
    default:
      return { message: ctx.defaultError };
  }
};

export function registerSpanishZodMessages(): void {
  z.setErrorMap(spanishErrorMap);
}
