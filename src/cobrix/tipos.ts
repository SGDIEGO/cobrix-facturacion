/**
 * Tipos y valores por defecto del lado de Cobrix: configuracion de la importacion,
 * corridas, facturas, clientes y eventos del historial.
 */

export type TipoPersona = 'natural' | 'juridica'
export type EstadoFactura = 'ABIERTA' | 'PAGADA'
export type TipoCorrida = 'IMPORTACION' | 'PAGADAS'
export type EstadoCorrida = 'COMPLETADA' | 'FALLIDA'

/** Lo que le paso a cada cuota del administrador en una corrida. */
export type ResultadoCuota =
	| 'importada'
	| 'ya_importada'
	| 'excluida_estado'
	| 'excluida_documento'
	| 'fuera_ventana'
	| 'limite_recientes'
	| 'frenada_tope'
	| 'moneda_no_admitida'
	| 'moneda_incoherente'
	| 'saldo_residual'
	| 'sin_deuda'
	| 'identificacion_invalida'
	| 'sin_periodo'
	| 'contradiccion'
	| 'marcada_pagada'
	| 'abono_parcial'
	| 'exonerada'
	| 'sin_evidencia'
	| 'pendiente_libro'
	| 'pendiente_contrato'

export interface Empresa {
	readonly nombre: string
	readonly rif: string
	readonly correoCobranza: string
}

export interface Proveedor {
	readonly url: string
	readonly usuario: string
	readonly password: string
}

/** Configuracion de la importacion (seccion 3.1 del enunciado). */
export interface Config {
	/** ACTIVO y CORTADO por defecto. */
	readonly estadosImportables: readonly string[]
	/** null = sin ventana: se traen todas las cuotas pendientes. */
	readonly ventanaMeses: number | null
	/** null = todas; 1..60 conserva las mas recientes de cada contrato. */
	readonly maxCuotasRecientes: number | null
	/** 0..60. */
	readonly diasGracia: number
	/** null = sin tope. */
	readonly maxFacturasNuevas: number | null
	/** null = sin tope, en centavos de USD. */
	readonly maxMontoNuevoCents: number | null
	/** V, E, J, G, P que no se importan. */
	readonly excluirTiposDocumento: readonly string[]
	readonly corridaAutomatica: boolean
	/** HH:MM en America/Caracas. */
	readonly horaCorrida: string
}

/**
 * Los valores por defecto reproducen los criterios de aceptacion: con `ventanaMeses: null`
 * y `maxCuotasRecientes: null` la importacion de la base entregada da 42 facturas por
 * USD 1.235,00. Cualquier ventana (3, 6) baja esos numeros, asi que la opcion por defecto
 * es "sin ventana".
 */
export const CONFIG_POR_DEFECTO: Config = {
	estadosImportables: ['ACTIVO', 'CORTADO'],
	ventanaMeses: null,
	maxCuotasRecientes: null,
	diasGracia: 0,
	maxFacturasNuevas: null,
	maxMontoNuevoCents: null,
	excluirTiposDocumento: [],
	corridaAutomatica: false,
	horaCorrida: '02:00',
}

export const ESTADOS_CONTRATO = ['ACTIVO', 'CORTADO', 'CORTESIA', 'RETIRADO', 'RECHAZADO', 'ANULADO'] as const
export const TIPOS_DOCUMENTO = ['V', 'E', 'J', 'G', 'P'] as const

/** Contadores de una corrida, para el resumen y el detalle. */
export interface Contadores {
	readonly cuotasRevisadas: number
	readonly importadas: number
	readonly yaImportadas: number
	readonly marcadasPagadas: number
	readonly abonosParciales: number
	readonly excluidas: number
	readonly frenadas: number
	readonly montoImportadoCents: number
	readonly clientesNuevos: number
}

export const CONTADORES_VACIOS: Contadores = {
	cuotasRevisadas: 0, importadas: 0, yaImportadas: 0, marcadasPagadas: 0,
	abonosParciales: 0, excluidas: 0, frenadas: 0, montoImportadoCents: 0, clientesNuevos: 0,
}

export interface Corrida {
	readonly id: number
	readonly tipo: TipoCorrida
	readonly simulacion: boolean
	readonly estado: EstadoCorrida
	readonly iniciadaEn: string
	readonly terminadaEn: string | null
	readonly resumen: Contadores
	readonly error: string
}

export interface CorridaItem {
	readonly id: number
	readonly contratoExterno: string
	readonly cuotaId: string
	readonly clienteDocumento: string
	readonly clienteNombre: string
	readonly resultado: ResultadoCuota
	readonly motivo: string
	readonly montoCents: number
	readonly detalle: string
}

export interface ClienteResumen {
	readonly id: number
	readonly documento: string
	readonly nombre: string
	readonly tipo: TipoPersona
	readonly contratos: number
	readonly abiertas: number
	readonly pagadas: number
	readonly deudaCents: number
	readonly vencimientoMasAntiguo: string | null
}

export interface ClienteDetalle {
	readonly id: number
	readonly documento: string
	readonly nombre: string
	readonly tipo: TipoPersona
	readonly email: string
	readonly telefono: string
	readonly origen: string
}

export interface ContratoDetalle {
	readonly idExterno: string
	readonly estado: string
	readonly plan: string
	readonly precioCents: number
	readonly sucursal: string
	readonly moneda: string
}

export interface FacturaDetalle {
	readonly id: number
	readonly numero: string
	readonly idExterno: string
	readonly contratoExterno: string
	readonly periodo: string
	readonly vencimiento: string
	readonly corte: string
	readonly totalCents: number
	readonly saldoCents: number
	readonly estado: EstadoFactura
	readonly pagadaEn: string | null
	readonly pagoFacturasIsp: string
}

export interface Evento {
	readonly id: number
	readonly tipo: 'cliente_creado' | 'factura_importada' | 'factura_pagada'
	readonly fecha: string
	readonly detalle: string
}

export interface Totales {
	readonly clientes: number
	readonly contratos: number
	readonly facturasAbiertas: number
	readonly facturasPagadas: number
	readonly porCobrarCents: number
	readonly vencidas: number
	readonly porVencer: number
}
