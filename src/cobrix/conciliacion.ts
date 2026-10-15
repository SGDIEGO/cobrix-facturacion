/**
 * Conciliacion entre lo que dice el administrador de facturas y lo que tiene Cobrix.
 *
 * Es la herramienta que responde "¿coinciden los dos sistemas?": recorre el libro de cuotas
 * de cada contrato que tiene facturas en Cobrix y compara, cuota por cuota. Sirve para
 * detectar cuotas que el ISP lista y Cobrix no tiene, facturas que el libro no conoce,
 * cuotas que quedaron sin evidencia y cobros que se reversaron.
 *
 * No escribe nada en Cobrix: solo lee el administrador y la base propia, y deja el informe
 * para mostrarlo en el panel.
 */

import type { ClienteApi, FilaLibro } from './clienteApi.ts'
import type { Almacen } from './almacen.ts'
import { periodoActual } from './normalizacion.ts'

export interface Diferencia {
	readonly contratoExterno: string
	readonly cuotaId: string
	readonly periodo: string
	readonly cliente: string
	/** Que se encontro en cada lado. */
	readonly enIsp: string
	readonly enCobrix: string
	/** Dinero en juego, en centavos. */
	readonly montoCents: number
}

export interface InformeConciliacion {
	readonly fecha: string
	readonly periodo: string
	readonly soloEnIsp: readonly Diferencia[]
	readonly soloEnCobrix: readonly Diferencia[]
	readonly noCoincide: readonly Diferencia[]
	readonly resumen: {
		readonly contratosRevisados: number
		readonly cuotasIsp: number
		readonly facturasCobrix: number
		readonly soloEnIsp: number
		readonly soloEnCobrix: number
		readonly noCoincide: number
		readonly montoSoloEnCobrixCents: number
		/** Cuotas futuras del libro: todavia no tocan, no son diferencia. */
		readonly cuotasFuturas: number
		/** Cuotas que el ISP ya cobro y que Cobrix correctamente no importo. */
		readonly cuotasCobradas: number
	}
	readonly errores: readonly string[]
}

export interface OpcionesConciliacion {
	readonly almacen: Almacen
	readonly api: ClienteApi
	readonly hoy: string
}

export async function conciliar(opciones: OpcionesConciliacion): Promise<InformeConciliacion> {
	const { almacen, api, hoy } = opciones
	const periodo = periodoActual(hoy)
	const facturas = almacen.facturasParaConciliar()
	const porContrato = new Map<string, typeof facturas>()
	for (const factura of facturas) {
		const lista = porContrato.get(factura.contratoExterno) ?? []
		lista.push(factura)
		porContrato.set(factura.contratoExterno, lista)
	}

	const soloEnIsp: Diferencia[] = []
	const soloEnCobrix: Diferencia[] = []
	const noCoincide: Diferencia[] = []
	const errores: string[] = []
	let cuotasIsp = 0
	let cuotasFuturas = 0
	let cuotasCobradas = 0
	const clientePorContrato = almacen.clientesPorContrato()

	// El libro se pide con un rango amplio: sin fechas la API usa una ventana fija vieja.
	const desde = '2000-01-01'
	const hasta = '2099-12-31'

	for (const [contrato, facturasDelContrato] of porContrato) {
		let filas: FilaLibro[]
		try {
			filas = await api.libroCuotas(Number(contrato), desde, hasta)
		} catch (error) {
			errores.push(`contrato ${contrato}: ${error instanceof Error ? error.message : String(error)}`)
			for (const factura of facturasDelContrato) {
				soloEnCobrix.push({
					contratoExterno: contrato, cuotaId: factura.idExterno, periodo: factura.periodo, cliente: '',
					enIsp: 'no se pudo leer el libro', enCobrix: factura.estado === 'PAGADA' ? 'pagada' : 'abierta',
					montoCents: factura.saldoCents,
				})
			}
			continue
		}

		cuotasIsp += filas.length

		// Lo que el libro conoce, agrupado por cuota.
		const porCuota = new Map<string, FilaLibro[]>()
		for (const fila of filas) {
			const lista = porCuota.get(String(fila.cuotaId)) ?? []
			lista.push(fila)
			porCuota.set(String(fila.cuotaId), lista)
		}

		for (const [cuotaId, filasDeLaCuota] of porCuota) {
			const primera = filasDeLaCuota[0]!
			const saldoIsp = Math.round(primera.saldoCuota * 100)
			const pagadoIsp = Math.round(primera.valorPago * 100)
			const factura = facturasDelContrato.find(f => f.idExterno === cuotaId)

			if (!factura) {
				// Lo que el administrador lista y Cobrix no tiene. Solo es diferencia lo que el
				// ISP sigue dando por vencido: las cuotas ya cobradas nunca se importan (correcto)
				// y las futuras todavía no tocan.
				const futura = primera.periodoCuota > periodo
				if (futura) cuotasFuturas += 1
				else if (saldoIsp > 1) {
					soloEnIsp.push({
						contratoExterno: contrato, cuotaId, periodo: primera.periodoCuota,
						cliente: clientePorContrato.get(contrato) ?? '',
						enIsp: `debe ${(saldoIsp / 100).toFixed(2)} (pagado ${(pagadoIsp / 100).toFixed(2)})`,
						enCobrix: 'no importada', montoCents: saldoIsp,
					})
				} else cuotasCobradas += 1
				continue
			}

			const estadoEsperado = saldoIsp <= 1 && pagadoIsp > 0 ? 'PAGADA' : 'ABIERTA'
			if (estadoEsperado !== factura.estado) {
				noCoincide.push({
					contratoExterno: contrato, cuotaId, periodo: factura.periodo,
					cliente: clientePorContrato.get(contrato) ?? '',
					enIsp: saldoIsp <= 1 && pagadoIsp > 0
						? `cobrada por completo (${(pagadoIsp / 100).toFixed(2)})`
						: `debe ${(saldoIsp / 100).toFixed(2)}`,
					enCobrix: factura.estado === 'PAGADA' ? 'pagada' : `abierta por ${(factura.saldoCents / 100).toFixed(2)}`,
					montoCents: factura.saldoCents,
				})
			}
		}

		for (const factura of facturasDelContrato) {
			if (!porCuota.has(factura.idExterno)) {
				soloEnCobrix.push({
					contratoExterno: contrato, cuotaId: factura.idExterno, periodo: factura.periodo, cliente: '',
					enIsp: 'no aparece en el libro', enCobrix: factura.estado === 'PAGADA' ? 'pagada' : `abierta por ${(factura.saldoCents / 100).toFixed(2)}`,
					montoCents: factura.saldoCents,
				})
			}
		}
	}

	return {
		fecha: new Date().toISOString(), periodo,
		soloEnIsp, soloEnCobrix, noCoincide,
		resumen: {
			contratosRevisados: porContrato.size, cuotasIsp, facturasCobrix: facturas.length,
			soloEnIsp: soloEnIsp.length, soloEnCobrix: soloEnCobrix.length, noCoincide: noCoincide.length,
			montoSoloEnCobrixCents: soloEnCobrix.reduce((suma, fila) => suma + fila.montoCents, 0),
			cuotasFuturas, cuotasCobradas,
		},
		errores,
	}
}
