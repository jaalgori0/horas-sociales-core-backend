/**
 * Modelo de solo mapeo para `careers`. El esquema lo define la migración SQL;
 * este modelo NO crea ni altera tablas.
 */
import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';
import { sequelize } from '../../../core/config/database.js';

export class Career extends Model<InferAttributes<Career>, InferCreationAttributes<Career>> {
  declare id: CreationOptional<string>;
  declare facultyId: string;
  declare nombre: string;
  declare activo: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Career.init(
  {
    // Sequelize envía NULL en un PK sin valor; se genera en la app (UUIDv4, igual que gen_random_uuid).
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    facultyId: { type: DataTypes.UUID, allowNull: false },
    nombre: { type: DataTypes.TEXT, allowNull: false },
    activo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    modelName: 'Career',
    tableName: 'careers',
  },
);
