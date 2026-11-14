/**
 * Modelo de mapeo para `students` (ver 001_init_unified_schema.sql).
 *
 * - `id` lo genera PostgreSQL (gen_random_uuid) y se obtiene vía RETURNING.
 * - `nombreCompleto` lo mantiene un trigger (nombres + apellidos): la app no lo asigna.
 *   En históricos del CSS `nombres`/`apellidos` son NULL y `nombreCompleto` guarda el
 *   bloque literal del reporte (migración 002).
 * - `duiHash` / `duiCifrado` son bytea; jamás se exponen en la API.
 */
import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from 'sequelize';
import { sequelize } from '../../../core/config/database.js';
import { Career } from '../../careers/models/career.model.js';

export const GENEROS = ['HOMBRE', 'MUJER'] as const;
export type Genero = (typeof GENEROS)[number];

export class Student extends Model<InferAttributes<Student>, InferCreationAttributes<Student>> {
  declare id: CreationOptional<string>;
  declare carnet: string;
  declare nombres: string | null;
  declare apellidos: string | null;
  declare nombreCompleto: CreationOptional<string>;
  declare correoInstitucional: string;
  declare emailPersonal: CreationOptional<string | null>;
  declare telefono: CreationOptional<string | null>;
  declare genero: CreationOptional<Genero | null>;
  declare avatarUrl: CreationOptional<string | null>;
  declare careerId: string;
  declare duiHash: CreationOptional<Buffer | null>;
  declare duiCifrado: CreationOptional<Buffer | null>;
  declare activo: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare career?: NonAttribute<Career>;
}

Student.init(
  {
    // Sequelize envía NULL en un PK sin valor; se genera en la app (UUIDv4, igual que gen_random_uuid).
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    carnet: { type: DataTypes.TEXT, allowNull: false },
    nombres: { type: DataTypes.TEXT, allowNull: true },
    apellidos: { type: DataTypes.TEXT, allowNull: true },
    nombreCompleto: { type: DataTypes.TEXT },
    correoInstitucional: { type: DataTypes.CITEXT, allowNull: false },
    emailPersonal: { type: DataTypes.CITEXT, allowNull: true },
    telefono: { type: DataTypes.TEXT, allowNull: true },
    genero: { type: DataTypes.TEXT, allowNull: true },
    avatarUrl: { type: DataTypes.TEXT, allowNull: true },
    careerId: { type: DataTypes.UUID, allowNull: false },
    duiHash: { type: DataTypes.BLOB, allowNull: true },
    duiCifrado: { type: DataTypes.BLOB, allowNull: true },
    activo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'Student',
    tableName: 'students',
  },
);

Student.belongsTo(Career, { as: 'career', foreignKey: 'careerId' });
