/**
 * Actualizacion de facturas pagadas (seccion 3.3 y 4 del enunciado).
 *
 * Cada corrida mira las facturas abiertas de Cobrix contra el libro de cuotas del
 * administrador (`pago_informacion`) y marca pagadas solo las que el ISP cobro por completo:
 * todas las filas de la cuota coinciden, el saldo es 0 y hay algo pagado.
 *
 * Reglas que esta corrida respeta:
 *   - saldo 0 sin nada pagado -> exonerada: NO es un pago;
 *   - saldo menor al de Cobrix -> abono parcial: se informa y la factura sigue abierta;
 *   - la cuota no aparece en el libro -> sin evidencia: nunca se marca pagada. Como la cuota
 *     del mes en curso puede no figurar todavia, se consulta el contrato antes de decidir;
 *   - filas que se contradigen -> sin evidencia.
 */

import type { ClienteApi, FilaLibro } from './clienteApi.ts'
import { Almacen } from './almacen.ts'
import type { Contadores, ResultadoCuota } from './tipos.ts'
import { CONTADORES_VACIOS } from './tipos.ts'
import { periodoActual, periodoMenos, sumarMeses, ultimoDiaDelPeriodo } from './normalizacion.ts'

export interface OpcionesPagadas {
	readonly almacen: Almacen
	readonly api: ClienteApi
	readonly hoy: string
	readonly simulacion: boolean
	readonly concurrencia?: number
}

export interface ResultadoPagadas {
	readonly corridaId: number
	readonly simulacion: boolean
	readonly estado: 'COMPLETADA' | 'FALLIDA'
	readonly contadores: Contadores
	readonly error: string
}

interface Evaluacion {
	readonly facturaId: number
	readonly idExterno: string
	readonly clienteId: number
	readonly clienteDocumento: string
	readonly clienteNombre: string
	readonly contratoExterno: string
	readonly resultado: ResultadoCuota
	readonly motivo: string
	readonly montoCents: number
	readonly pagada: boolean
	readonly facturasIsp: string
}

const CONCURRENCIA = 4
/** Dos filas del libro coinciden si sus montos son iguales al centavo. */
const TOLERANCIA_CENTS = 1

async function enLotes<T, R>(items: readonly T[], tamano: number, trabajar: (item: T) => Promise<R>): Promise<R[]> {
	const salida: R[] = []
	for (let i = 0; i < items.length; i += tamano) {
		salida.push(...await Promise.all(items.slice(i, i + tamano).map(trabajar)))
	}
	return salida
}

export async function actualizarPagadas(opciones: OpcionesPagadas): Promise<ResultadoPagadas> {
	const { almacen, api, hoy, simulacion } = opciones
	const corridaId = almacen.abrirCorrida('PAGADAS', simulacion)
	try {
		const contadores = await correr(almacen, api, hoy, simulacion, corridaId, opciones.concurrencia ?? CONCURRENCIA)
		almacen.cerrarCorrida(corridaId, 'COMPLETADA', contadores)
		return { corridaId, simulacion, estado: 'COMPLETADA', contadores, error: '' }
	} catch (error) {
		const mensaje = error instanceof Error ? error.message : String(error)
		almacen.cerrarCorrida(corridaId, 'FALLIDA', CONTADORES_VACIOS, mensaje)
		return { corridaId, simulacion, estado: 'FALLIDA', contadores: CONTADORES_VACIOS, error: mensaje }
	}
}

/** Resultado posible de una factura al compararla con el libro de cuotas. */
type Veredicto =
	| { readonly tipo: 'pagada'; readonly facturasIsp: string }
	| { readonly tipo: 'abono_parcial'; readonly pagadoCents: number; readonly saldoCents: number; readonly facturasIsp: string }
	| { readonly tipo: 'sigue_pendiente'; readonly saldoCents: number; readonly facturasIsp: string }
	| { readonly tipo: 'exonerada'; readonly facturasIsp: string }
	| { readonly tipo: 'sin_evidencia'; readonly motivo: string }

/** Compara una factura de Cobrix con las filas del libro de cuotas del ISP. */
function evaluarCuota(factura: { id: number; saldo_cents: number }, filas: readonly FilaLibro[]): Veredicto {
	if (filas.length === 0) return { tipo: 'sin_evidencia', motivo: 'la cuota no aparece en el libro de pagos' }

	const primera = filas[0]!
	const coherente = filas.every(fila =>
		fila.periodoCuota === primera.periodoCuota
		&& Math.round(fila.saldoCuota * 100) === Math.round(primera.saldoCuota * 100)
		&& Math.round(fila.valorPago * 100) === Math.round(primera.valorPago * 100)
		&& Math.round(fila.tarifa * 100) === Math.round(primera.tarifa * 100))
	if (!coherente) return { tipo: 'sin_evidencia', motivo: 'las filas de la cuota no coinciden entre si' }

	const saldoCents = Math.round(primera.saldoCuota * 100)
	const pagadoCents = Math.round(primera.valorPago * 100)
	const facturasIsp = [...new Set(filas.filter(fila => fila.facturaId > 0).map(fila => fila.numFactura || String(fila.facturaId)))].join(', ')

	if (saldoCents <= TOLERANCIA_CENTS && pagadoCents > 0) return { tipo: 'pagada', facturasIsp }
	if (saldoCents <= TOLERANCIA_CENTS) return { tipo: 'exonerada', facturasIsp }
	if (saldoCents < factura.saldo_cents) return { tipo: 'abono_parcial', pagadoCents, saldoCents, facturasIsp }
	return { tipo: 'sigue_pendiente', saldoCents, facturasIsp }
}

/**
 * Revision de las facturas que Cobrix ya tiene como pagadas: si el ISP anulo el cobro (el
 * libro vuelve a mostrar saldo), la factura se reabre. Es el camino inverso de
 * "marcar pagada" y el que hace que una anulacion se refleje en el panel.
 */
async function revisarPagadas(
	almacen: Almacen, api: ClienteApi, desde: string, hasta: string, simulacion: boolean, corridaId: number,
	periodo: string, contadores: { -readonly [K in keyof Contadores]: Contadores[K] },
): Promise<void> {
	const pagadas = almacen.facturasPagadas()
	if (pagadas.length === 0) return
	const contratos = [...new Set(pagadas.map(factura => factura.contrato_externo))]
	const libros = new Map<string, FilaLibro[]>()
	const pendientes = new Map<string, Set<string>>()
	const consultados = new Set<string>()

	for (const contrato of contratos) {
		try {
			libros.set(contrato, await api.libroCuotas(Number(contrato), desde, hasta))
		} catch {
			libros.set(contrato, [])
		}
	}

	for (const factura of pagadas) {
		const filas = (libros.get(factura.contrato_externo) ?? []).filter(fila => fila.cuotaId === Number(factura.id_externo))
		const veredicto = evaluarCuota(factura, filas)

		if (veredicto.tipo === 'sin_evidencia') {
			// La cuota del mes en curso puede no figurar en el libro: se consulta el contrato.
			const esMesEnCurso = factura.periodo >= periodo
			if (esMesEnCurso && !consultados.has(factura.contrato_externo)) {
				consultados.add(factura.contrato_externo)
				try {
					const cuotas = await api.cuotasContrato(Number(factura.contrato_externo))
					pendientes.set(factura.contrato_externo, new Set(cuotas.map(cuota => String(cuota.deudaId))))
				} catch {
					pendientes.set(factura.contrato_externo, new Set())
				}
			}
			const sigueEnContrato = esMesEnCurso && (pendientes.get(factura.contrato_externo)?.has(factura.id_externo) ?? false)
			const resultado: ResultadoCuota = sigueEnContrato ? 'pendiente_contrato' : 'sin_evidencia'
			almacen.registrarItem(corridaId, {
				contratoExterno: factura.contrato_externo, cuotaId: factura.id_externo,
				clienteDocumento: factura.cliente_documento, clienteNombre: factura.cliente_nombre,
				resultado, motivo: sigueEnContrato
					? 'la cuota sigue pendiente en el contrato: la factura pagada no se reabre'
					: 'sin evidencia en el libro: la factura pagada se deja como esta',
				montoCents: factura.saldo_cents, detalle: '',
			})
			contadores.cuotasRevisadas += 1
			continue
		}

		const esReapertura = veredicto.tipo === 'abono_parcial' || veredicto.tipo === 'sigue_pendiente'
		if (!esReapertura) {
			almacen.registrarItem(corridaId, {
				contratoExterno: factura.contrato_externo, cuotaId: factura.id_externo,
				clienteDocumento: factura.cliente_documento, clienteNombre: factura.cliente_nombre,
				resultado: 'marcada_pagada',
				motivo: 'sigue pagada en el libro de cuotas',
				montoCents: 0, detalle: '',
			})
			contadores.cuotasRevisadas += 1
			continue
		}

		const saldo = veredicto.tipo === 'abono_parcial' ? veredicto.saldoCents : veredicto.saldoCents
		const pagado = veredicto.tipo === 'abono_parcial' ? veredicto.pagadoCents : 0
		if (!simulacion) almacen.reabrirFactura(factura.id, saldo)
		almacen.registrarEvento({
			clienteId: factura.cliente_id, facturaId: factura.id, tipo: 'factura_reabierta',
			detalle: `el administrador anulo o reverso el cobro de la cuota ${factura.id_externo}: vuelve a deber USD ${(saldo / 100).toFixed(2)}`,
		})
		almacen.registrarItem(corridaId, {
			contratoExterno: factura.contrato_externo, cuotaId: factura.id_externo,
			clienteDocumento: factura.cliente_documento, clienteNombre: factura.cliente_nombre,
			resultado: 'reabierta',
			motivo: veredicto.tipo === 'abono_parcial'
				? `el cobro se reverso a un abono de USD ${(pagado / 100).toFixed(2)}: la factura se reabre con USD ${(saldo / 100).toFixed(2)}`
				: `el cobro fue anulado: la factura se reabre con USD ${(saldo / 100).toFixed(2)}`,
			montoCents: saldo, detalle: veredicto.facturasIsp,
		})
		contadores.reabiertas += 1
		contadores.cuotasRevisadas += 1
	}
}

async function correr(
	almacen: Almacen, api: ClienteApi, hoy: string, simulacion: boolean, corridaId: number, concurrencia: number,
): Promise<Contadores> {
	const periodo = periodoActual(hoy)
	const abiertas = almacen.facturasAbiertas()
	const contratos = [...new Set(abiertas.map(factura => factura.contrato_externo))]

	// El libro se pide por rango de fechas de emision: sin fechas la API usa una ventana fija vieja.
	const menorPeriodo = abiertas.reduce<string | null>((minimo, factura) =>
		minimo === null || factura.periodo < minimo ? factura.periodo : minimo, null)
	const desde = `${periodoMenos(menorPeriodo ?? periodo, 1)}-01`
	const hasta = ultimoDiaDelPeriodo(sumarMeses(periodo, 1))

	const libros = new Map<string, FilaLibro[]>()
	const pendientesPorContrato = new Map<string, Set<string>>()
	const contratosConsultados = new Set<string>()
	const evaluaciones: Evaluacion[] = []

	await enLotes(contratos, concurrencia, async contrato => {
		try {
			libros.set(contrato, await api.libroCuotas(Number(contrato), desde, hasta))
		} catch (error) {
			libros.set(contrato, [])
			const mensaje = error instanceof Error ? error.message : String(error)
			for (const factura of abiertas.filter(f => f.contrato_externo === contrato)) {
				evaluaciones.push({
					facturaId: factura.id, idExterno: factura.id_externo, clienteId: factura.cliente_id,
					clienteDocumento: factura.cliente_documento, clienteNombre: factura.cliente_nombre,
					contratoExterno: contrato, resultado: 'sin_evidencia',
					motivo: `no se pudo leer el libro de cuotas: ${mensaje}`,
					montoCents: factura.saldo_cents, pagada: false, facturasIsp: '',
				})
			}
		}
	})

	for (const factura of abiertas) {
		if (evaluaciones.some(e => e.facturaId === factura.id)) continue
		const filas = (libros.get(factura.contrato_externo) ?? []).filter(fila => fila.cuotaId === Number(factura.id_externo))
		const clienteId = factura.cliente_id

		if (filas.length === 0) {
			// La cuota del mes en curso puede no figurar en el libro hasta fin de mes: se consulta el contrato.
			const esMesEnCurso = factura.periodo >= periodo
			let pendienteEnContrato = false
			if (esMesEnCurso && !contratosConsultados.has(factura.contrato_externo)) {
				contratosConsultados.add(factura.contrato_externo)
				try {
					const cuotas = await api.cuotasContrato(Number(factura.contrato_externo))
					pendientesPorContrato.set(factura.contrato_externo, new Set(cuotas.map(cuota => String(cuota.deudaId))))
				} catch {
					pendientesPorContrato.set(factura.contrato_externo, new Set())
				}
			}
			pendienteEnContrato = esMesEnCurso && (pendientesPorContrato.get(factura.contrato_externo)?.has(factura.id_externo) ?? false)
			evaluaciones.push({
				facturaId: factura.id, idExterno: factura.id_externo, clienteId, clienteDocumento: factura.cliente_documento, clienteNombre: factura.cliente_nombre, contratoExterno: factura.contrato_externo,
				resultado: pendienteEnContrato ? 'pendiente_contrato' : 'sin_evidencia',
				motivo: pendienteEnContrato
					? 'la cuota no aparece en el libro de pagos, pero sigue pendiente en el contrato: no se marca pagada'
					: 'la cuota no aparece en el libro de pagos: sin evidencia no se marca pagada',
				montoCents: factura.saldo_cents, pagada: false, facturasIsp: '',
			})
			continue
		}

		const primera = filas[0]!
		const coherente = filas.every(fila =>
			fila.periodoCuota === primera.periodoCuota
			&& Math.round(fila.saldoCuota * 100) === Math.round(primera.saldoCuota * 100)
			&& Math.round(fila.valorPago * 100) === Math.round(primera.valorPago * 100)
			&& Math.round(fila.tarifa * 100) === Math.round(primera.tarifa * 100))
		if (!coherente) {
			evaluaciones.push({
				facturaId: factura.id, idExterno: factura.id_externo, clienteId, clienteDocumento: factura.cliente_documento, clienteNombre: factura.cliente_nombre, contratoExterno: factura.contrato_externo,
				resultado: 'sin_evidencia',
				motivo: `las ${filas.length} filas de la cuota no coinciden entre si: sin evidencia no se marca pagada`,
				montoCents: factura.saldo_cents, pagada: false, facturasIsp: '',
			})
			continue
		}

		const saldoCents = Math.round(primera.saldoCuota * 100)
		const pagadoCents = Math.round(primera.valorPago * 100)
		const facturasIsp = [...new Set(filas.filter(fila => fila.facturaId > 0).map(fila => fila.numFactura || String(fila.facturaId)))].join(', ')

		if (saldoCents <= TOLERANCIA_CENTS && pagadoCents > 0) {
			evaluaciones.push({
				facturaId: factura.id, idExterno: factura.id_externo, clienteId, clienteDocumento: factura.cliente_documento, clienteNombre: factura.cliente_nombre, contratoExterno: factura.contrato_externo,
				resultado: 'marcada_pagada',
				motivo: facturasIsp
					? `saldo 0 con USD ${(pagadoCents / 100).toFixed(2)} pagados en la(s) factura(s) ${facturasIsp}`
					: 'saldo 0 con lo pagado por el ISP',
				montoCents: pagadoCents, pagada: true, facturasIsp,
			})
			continue
		}
		if (saldoCents <= TOLERANCIA_CENTS && pagadoCents <= 0) {
			evaluaciones.push({
				facturaId: factura.id, idExterno: factura.id_externo, clienteId, clienteDocumento: factura.cliente_documento, clienteNombre: factura.cliente_nombre, contratoExterno: factura.contrato_externo,
				resultado: 'exonerada',
				motivo: 'saldo 0 sin nada pagado (descuento): no es un pago',
				montoCents: 0, pagada: false, facturasIsp: facturasIsp,
			})
			continue
		}
		if (saldoCents < factura.saldo_cents) {
			evaluaciones.push({
				facturaId: factura.id, idExterno: factura.id_externo, clienteId, clienteDocumento: factura.cliente_documento, clienteNombre: factura.cliente_nombre, contratoExterno: factura.contrato_externo,
				resultado: 'abono_parcial',
				motivo: `el ISP tiene USD ${(pagadoCents / 100).toFixed(2)} pagados y USD ${(saldoCents / 100).toFixed(2)} de saldo: la factura sigue abierta`,
				montoCents: pagadoCents, pagada: false, facturasIsp: facturasIsp,
			})
			continue
		}
		evaluaciones.push({
			facturaId: factura.id, idExterno: factura.id_externo, clienteId, clienteDocumento: factura.cliente_documento, clienteNombre: factura.cliente_nombre, contratoExterno: factura.contrato_externo,
			resultado: 'pendiente_libro',
			motivo: `el libro muestra un saldo de USD ${(saldoCents / 100).toFixed(2)}: sigue pendiente`,
			montoCents: saldoCents, pagada: false, facturasIsp: facturasIsp,
		})
	}

	const contadores = { ...CONTADORES_VACIOS, cuotasRevisadas: evaluaciones.length }
	if (!simulacion) {
		for (const evaluacion of evaluaciones) {
			if (!evaluacion.pagada) continue
			almacen.marcarPagada(evaluacion.facturaId, evaluacion.facturasIsp)
			almacen.registrarEvento({
				clienteId: evaluacion.clienteId, facturaId: evaluacion.facturaId, tipo: 'factura_pagada',
				detalle: `cuota ${evaluacion.idExterno} pagada en el administrador${evaluacion.facturasIsp ? ` (factura ${evaluacion.facturasIsp})` : ''}`,
			})
			contadores.marcadasPagadas += 1
		}
	} else {
		contadores.marcadasPagadas = evaluaciones.filter(e => e.pagada).length
	}
	for (const evaluacion of evaluaciones) {
		if (evaluacion.resultado === 'abono_parcial') {
			contadores.abonosParciales += 1
			almacen.registrarEvento({
				clienteId: evaluacion.clienteId, facturaId: evaluacion.facturaId, tipo: 'factura_abono',
				detalle: `abono parcial en la cuota ${evaluacion.idExterno}: ${evaluacion.motivo}`,
			})
		}
		if (evaluacion.resultado === 'exonerada' || evaluacion.resultado === 'sin_evidencia'
			|| evaluacion.resultado === 'pendiente_contrato' || evaluacion.resultado === 'pendiente_libro') contadores.excluidas += 1
		almacen.registrarItem(corridaId, {
			contratoExterno: evaluacion.contratoExterno, cuotaId: evaluacion.idExterno,
			clienteDocumento: evaluacion.clienteDocumento, clienteNombre: evaluacion.clienteNombre,
			resultado: evaluacion.resultado,
			motivo: evaluacion.motivo, montoCents: evaluacion.montoCents, detalle: evaluacion.facturasIsp,
		})
	}

	// Ademas: las que ya estaban pagadas se revisan por si el administrador anulo el cobro.
	await revisarPagadas(almacen, api, desde, hasta, simulacion, corridaId, periodo, contadores)
	return contadores
}
