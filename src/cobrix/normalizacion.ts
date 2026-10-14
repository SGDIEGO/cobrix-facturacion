/**
 * Lectura estricta de lo que devuelve el administrador de facturas. Nada de lo que venga
 * raro se adivina: cada funcion dice si puede o no interpretar el dato.
 */

import type { TipoPersona } from './tipos.ts'

const LETRAS_DOCUMENTO = new Set(['V', 'E', 'J', 'G', 'P'])

export interface Identificacion {
	/** Documento normalizado: letra opcional + digitos sin ceros a la izquierda. */
	readonly documento: string
	readonly letra: string | null
	readonly digitos: string
}

export type Lectura<T> = { readonly ok: true; readonly valor: T } | { readonly ok: false; readonly motivo: string }

const falla = (motivo: string): Lectura<never> => ({ ok: false, motivo })

/**
 * `V-12345678` -> `V12345678`; `09000123` -> `9000123`; `J-40123456-7` -> `J401234567`.
 * Letra de tipo opcional, de 6 a 12 digitos, sin separadores ni ceros a la izquierda.
 */
export function normalizarIdentificacion(valor: unknown): Lectura<Identificacion> {
	if (typeof valor !== 'string') return falla('la identificacion no es texto')
	const texto = valor.trim().toUpperCase()
	if (!texto) return falla('identificacion vacia')
	const match = /^([VEGJP])?[-. ]?(\d{6,12})(?:-(\d))?$/.exec(texto)
	if (!match) return falla(`identificacion con formato no reconocido: ${texto}`)
	const letra = match[1] ?? null
	const digitos = `${match[2] ?? ''}${match[3] ?? ''}`.replace(/^0+/, '')
	if (digitos.length < 6 || digitos.length > 12) return falla(`identificacion con ${digitos.length} digitos, se esperaban 6 a 12`)
	return { ok: true, valor: { documento: `${letra ?? ''}${digitos}`, letra, digitos } }
}

/** J y G son personas juridicas; el resto, naturales. */
export function tipoPersona(letra: string | null): TipoPersona {
	return letra === 'J' || letra === 'G' ? 'juridica' : 'natural'
}

const MESES: Record<string, number> = {
	ENERO: 1, FEBRERO: 2, MARZO: 3, ABRIL: 4, MAYO: 5, JUNIO: 6,
	JULIO: 7, AGOSTO: 8, SEPTIEMBRE: 9, SETIEMBRE: 9, OCTUBRE: 10, NOVIEMBRE: 11, DICIEMBRE: 12,
	ENE: 1, FEB: 2, MAR: 3, ABR: 4, MAY: 5, JUN: 6, JUL: 7, AGO: 8, SEP: 9, SET: 9, OCT: 10, NOV: 11, DIC: 12,
}

/** `2026-08` + 3 -> `2026-11`. */
export function sumarMeses(periodo: string, meses: number): string {
	const [anio, mes] = periodo.split('-').map(Number) as [number, number]
	const indice = anio * 12 + (mes - 1) + meses
	return `${Math.floor(indice / 12)}-${String((indice % 12) + 1).padStart(2, '0')}`
}

/** El periodo YYYY-MM que esta `meses` antes de `periodo`. */
export function periodoMenos(periodo: string, meses: number): string {
	return sumarMeses(periodo, -meses)
}

export const periodoActual = (hoy: string): string => hoy.slice(0, 7)

/**
 * De `"PLAN15MB25 - 2026 Agosto"` sale el periodo `2026-08`. El vencimiento de la cuota es
 * el primer dia de ese periodo: `2026-08-01`.
 */
export function leerPeriodo(detalle: unknown): Lectura<string> {
	if (!Array.isArray(detalle)) return falla('detalle_deuda no es una lista')
	const etiqueta = detalle.find((item): item is string => typeof item === 'string' && item.includes('-'))
	if (!etiqueta) return falla('detalle_deuda sin etiqueta "PLAN - YYYY Mes"')
	const match = /(\d{4})\s+([A-Za-zÁÉÍÓÚáéíóúÑñ]+)/.exec(etiqueta)
	if (!match) return falla(`no se pudo leer el periodo de "${etiqueta}"`)
	const mes = MESES[(match[2] ?? '').toUpperCase()]
	if (!mes) return falla(`mes no reconocido en "${etiqueta}"`)
	return { ok: true, valor: `${match[1] ?? ''}-${String(mes).padStart(2, '0')}` }
}

/** El vencimiento de una cuota es el primer dia de su periodo. */
export const vencimientoDePeriodo = (periodo: string): string => `${periodo}-01`

/** La fecha de corte es el vencimiento mas los dias de gracia. */
export function fechaCorte(vencimiento: string, diasGracia: number): string {
	const fecha = new Date(`${vencimiento}T00:00:00Z`)
	fecha.setUTCDate(fecha.getUTCDate() + Math.max(0, Math.trunc(diasGracia)))
	return fecha.toISOString().slice(0, 10)
}

/** Ultimo dia del periodo, para acotar consultas al libro de cuotas. */
export function ultimoDiaDelPeriodo(periodo: string): string {
	const siguiente = `${sumarMeses(periodo, 1)}-01T00:00:00Z`
	return new Date(new Date(siguiente).getTime() - 86_400_000).toISOString().slice(0, 10)
}

/** Montos en centavos de USD: enteros, sin sorpresas de punto flotante. */
export function aCentavos(monto: unknown): number {
	const numero = typeof monto === 'number' ? monto : Number(monto)
	if (!Number.isFinite(numero)) return 0
	return Math.round(numero * 100)
}

export function aNumero(valor: unknown): number {
	const numero = typeof valor === 'number' ? valor : Number(valor)
	return Number.isFinite(numero) ? numero : Number.NaN
}

/** El administrador devuelve `deuda_id: "0"` cuando el contrato no debe nada. */
export const esFilaSinDeuda = (deudaId: unknown): boolean => String(deudaId ?? '').trim() === '0'

/** Un saldo que redondea a menos de un centavo no es una cuota importable. */
export function esSaldoResidual(saldoCents: number): boolean {
	return Math.abs(saldoCents) < 1
}
