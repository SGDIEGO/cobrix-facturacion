/**
 * Punto de entrada del lado de Cobrix. El panel (`src/web/app.ts`) usa solo esto.
 */

export { Almacen, ALMACEN_POR_DEFECTO, fusionarConfig } from './almacen.ts'
export { ClienteApi, ErrorApi, type CuotaPendiente, type FilaLibro } from './clienteApi.ts'
export { importar, type OpcionesImportacion, type ResultadoImportacion } from './importar.ts'
export { actualizarPagadas, type OpcionesPagadas, type ResultadoPagadas } from './pagadas.ts'
export { crearPlanificador, proximaEjecucion, type Planificador } from './planificador.ts'
export {
	CONFIG_POR_DEFECTO, CONTADORES_VACIOS, ESTADOS_CONTRATO, TIPOS_DOCUMENTO,
	type ClienteDetalle, type ClienteResumen, type Config, type Contadores, type ContratoDetalle,
	type Corrida, type CorridaItem, type Empresa, type Evento, type FacturaDetalle, type Proveedor,
	type ResultadoCuota, type TipoCorrida, type TipoPersona, type Totales,
} from './tipos.ts'
export * as reglas from './normalizacion.ts'
