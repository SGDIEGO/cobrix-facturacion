/**
 * Importacion de clientes y facturas (seccion 3.2 y 4 del enunciado).
 *
 * Una corrida recorre todos los contratos del administrador y, por cada cuota pendiente que
 * cumpla las reglas, crea una factura abierta y, si no existe, su cliente. El mismo camino
 * corre en modo simulacion: identico, pero sin escribir nada.
 *
 * Decisiones que la corrida deja por escrito en `motivo` (nada se adivina):
 *   - filas de otro contrato o cuotas duplicadas con datos distintos -> el contrato queda fuera;
 *   - `deuda_id: "0"` (sin deuda) y saldos de menos de un centavo no son cuotas;
 *   - USD con montos por debajo del 1 % del precio del plan -> moneda incoherente.
 */

import type { ClienteApi, CuotaPendiente } from './clienteApi.ts'
import { Almacen } from './almacen.ts'
import type { Config, Contadores, ResultadoCuota, TipoPersona } from './tipos.ts'
import { CONTADORES_VACIOS } from './tipos.ts'
import {
	aCentavos, esFilaSinDeuda, esSaldoResidual, fechaCorte, leerPeriodo,
	normalizarIdentificacion, periodoActual, periodoMenos, tipoPersona, vencimientoDePeriodo,
} from './normalizacion.ts'

export interface OpcionesImportacion {
	readonly almacen: Almacen
	readonly api: ClienteApi
	/** Fecha de hoy (YYYY-MM-DD), normalmente `today()` del entorno. */
	readonly hoy: string
	readonly simulacion: boolean
	readonly concurrencia?: number
}

export interface ResultadoImportacion {
	readonly corridaId: number
	readonly simulacion: boolean
	readonly estado: 'COMPLETADA' | 'FALLIDA'
	readonly contadores: Contadores
	readonly error: string
}

interface Candidata {
	readonly cuota: CuotaPendiente
	readonly cliente: { documento: string; nombre: string; tipo: TipoPersona; email: string; telefono: string }
	readonly periodo: string
	readonly vencimiento: string
	readonly corte: string
	readonly montoCents: number
}

interface LoteContrato {
	readonly id: number
	readonly cuotas: readonly CuotaPendiente[]
	readonly fallo?: boolean
}

interface Evaluada {
	readonly cuota: CuotaPendiente
	readonly resultado: ResultadoCuota
	readonly motivo: string
	readonly candidata?: Candidata
}

/** Documento normalizado de la fila, o vacio si la identificacion no se puede leer. */
const documentoDe = (cuota: CuotaPendiente): string => {
	const lectura = normalizarIdentificacion(cuota.identificacion)
	return lectura.ok ? lectura.valor.documento : ''
}

const CONCURRENCIA = 4

/** Recorre los contratos de a pocos a la vez: la API es local, pero esto la respeta. */
async function enLotes<T, R>(items: readonly T[], tamano: number, trabajar: (item: T) => Promise<R>): Promise<R[]> {
	const salida: R[] = []
	for (let i = 0; i < items.length; i += tamano) {
		const lote = items.slice(i, i + tamano)
		salida.push(...await Promise.all(lote.map(trabajar)))
	}
	return salida
}

export async function importar(opciones: OpcionesImportacion): Promise<ResultadoImportacion> {
	const { almacen, api, hoy, simulacion } = opciones
	const config = almacen.leerConfig()
	const periodo = periodoActual(hoy)
	const corridaId = almacen.abrirCorrida('IMPORTACION', simulacion)

	try {
		const plan = await planificar(almacen, api, config, periodo, opciones.concurrencia ?? CONCURRENCIA)
		const contadores = await aplicar(almacen, plan.candidatas, plan.evaluadas, simulacion, corridaId)
		almacen.cerrarCorrida(corridaId, plan.erroresLectura.length > 0 ? 'FALLIDA' : 'COMPLETADA', contadores,
			plan.erroresLectura.length > 0 ? plan.erroresLectura.join(' | ') : '')
		return { corridaId, simulacion, estado: plan.erroresLectura.length > 0 ? 'FALLIDA' : 'COMPLETADA', contadores, error: plan.erroresLectura.join(' | ') }
	} catch (error) {
		// Credenciales malas, API caida, respuesta ilegible: la corrida queda registrada como fallida.
		const mensaje = error instanceof Error ? error.message : String(error)
		almacen.cerrarCorrida(corridaId, 'FALLIDA', CONTADORES_VACIOS, mensaje)
		return { corridaId, simulacion, estado: 'FALLIDA', contadores: CONTADORES_VACIOS, error: mensaje }
	}
}

interface Plan {
	readonly evaluadas: Evaluada[]
	readonly candidatas: Candidata[]
	readonly erroresLectura: string[]
}

/** Lee todo el administrador y decide, cuota por cuota, que se importa y que no. */
async function planificar(almacen: Almacen, api: ClienteApi, config: Config, periodo: string, concurrencia: number): Promise<Plan> {
	const ids = await api.idsContratos()
	const evaluadas: Evaluada[] = []
	const erroresLectura: string[] = []

	const lotes = await enLotes<number, LoteContrato>(ids, concurrencia, async id => {
		try {
			return { id, cuotas: await api.cuotasContrato(id) }
		} catch (error) {
			const mensaje = error instanceof Error ? error.message : String(error)
			erroresLectura.push(`contrato ${id}: ${mensaje}`)
			return { id, cuotas: [], fallo: true }
		}
	})

	const candidatas: Candidata[] = []

	for (const lote of lotes) {
		const contrato = String(lote.id)
		if (lote.fallo || lote.cuotas.length === 0) {
			const mensaje = lote.fallo
				? 'la API no devolvio las cuotas del contrato'
				: 'la API devolvio una lista vacia: no se puede confirmar la deuda'
			evaluadas.push({ cuota: filaVacia(lote.id), resultado: 'contradiccion', motivo: mensaje })
			continue
		}
		const cuotas = lote.cuotas

		// 1. La respuesta no puede mezclar contratos ni repetir cuotas con datos distintos.
		const ajenas = cuotas.filter(cuota => cuota.contratoId !== lote.id)
		if (ajenas.length > 0) {
			for (const cuota of cuotas) evaluadas.push({ cuota, resultado: 'contradiccion', motivo: `la respuesta trae ${ajenas.length} fila(s) de otro contrato` })
			continue
		}
		const vistos = new Map<string, CuotaPendiente>()
		let duplicada = false
		for (const cuota of cuotas) {
			const previa = vistos.get(cuota.deudaId)
			if (previa && (previa.deuda !== cuota.deuda || previa.detalleDeuda.join('|') !== cuota.detalleDeuda.join('|'))) duplicada = true
			vistos.set(cuota.deudaId, cuota)
		}
		if (duplicada) {
			for (const cuota of cuotas) evaluadas.push({ cuota, resultado: 'contradiccion', motivo: 'la misma cuota aparece dos veces con datos distintos' })
			continue
		}

		// 2. Lo que se decide por contrato: estado, moneda y tipo de documento.
		const estado = cuotas[0]!.estado
		const estadoImportable = config.estadosImportables.includes(estado)
		const moneda = cuotas[0]!.monedaSigla
		const precio = cuotas[0]!.precioPlan
		const deudas = cuotas.filter(cuota => !esFilaSinDeuda(cuota.deudaId)).map(cuota => cuota.deuda)
		const mayorDeuda = deudas.length > 0 ? Math.max(...deudas) : 0
		const proporcion = mayorDeuda / precio
		const monedaIncoherente = deudas.length > 0 && moneda === 'USD' && Number.isFinite(precio) && precio > 0 && proporcion < 0.01
		const monedaNoAdmitida = moneda !== 'USD'

		for (const cuota of cuotas) {
			if (!estadoImportable) {
				evaluadas.push({ cuota, resultado: 'excluida_estado', motivo: `el contrato esta ${estado || 'SIN ESTADO'} y solo se importan ${config.estadosImportables.join(', ')}` })
				continue
			}
			if (monedaNoAdmitida) {
				evaluadas.push({ cuota, resultado: 'moneda_no_admitida', motivo: `la API reporta ${moneda || 'moneda desconocida'} y solo se importa USD` })
				continue
			}
			if (monedaIncoherente) {
				evaluadas.push({ cuota, resultado: 'moneda_incoherente', motivo: `cuotas de USD ${mayorDeuda} frente a un plan de USD ${precio}: el contrato no cotiza en USD` })
				continue
			}

			const identificacion = normalizarIdentificacion(cuota.identificacion)
			if (!identificacion.ok) {
				evaluadas.push({ cuota, resultado: 'identificacion_invalida', motivo: identificacion.motivo })
				continue
			}
			const letra = identificacion.valor.letra
			if (letra && config.excluirTiposDocumento.includes(letra)) {
				evaluadas.push({ cuota, resultado: 'excluida_documento', motivo: `el tipo de documento ${letra} esta excluido en la configuracion` })
				continue
			}
			if (esFilaSinDeuda(cuota.deudaId)) {
				evaluadas.push({ cuota, resultado: 'sin_deuda', motivo: 'la fila con deuda_id "0" significa que el contrato no debe nada' })
				continue
			}
			const montoCents = aCentavos(cuota.deuda)
			if (esSaldoResidual(montoCents)) {
				evaluadas.push({ cuota, resultado: 'saldo_residual', motivo: `saldo de USD ${(Math.abs(cuota.deuda) || montoCents / 100).toFixed(6)}: menos de un centavo no es una cuota` })
				continue
			}
			const lectura = leerPeriodo(cuota.detalleDeuda)
			if (!lectura.ok) {
				evaluadas.push({ cuota, resultado: 'sin_periodo', motivo: lectura.motivo })
				continue
			}
			const periodoCuota = lectura.valor
			if (config.ventanaMeses !== null && periodoCuota < periodoMenos(periodo, config.ventanaMeses)) {
				evaluadas.push({ cuota, resultado: 'fuera_ventana', motivo: `${periodoCuota} queda fuera de la ventana de ${config.ventanaMeses} meses` })
				continue
			}
			const existente = almacen.facturaPorExterno(cuota.deudaId)
			if (existente) {
				evaluadas.push({ cuota, resultado: 'ya_importada', motivo: `la cuota ya es la factura ${existente.estado === 'PAGADA' ? 'pagada' : 'abierta'} de Cobrix` })
				continue
			}
			const vencimiento = vencimientoDePeriodo(periodoCuota)
			candidatas.push({
				cuota,
				cliente: {
					documento: identificacion.valor.documento,
					nombre: cuota.nombre || '(sin nombre en el administrador)',
					tipo: tipoPersona(letra),
					email: cuota.email, telefono: cuota.telefono,
				},
				periodo: periodoCuota, vencimiento, corte: fechaCorte(vencimiento, config.diasGracia), montoCents,
			})
		}
	}

	// 3. Maximo de cuotas recientes por contrato: se conservan las mas nuevas.
	const porContrato = new Map<string, Candidata[]>()
	for (const candidata of candidatas) {
		const lista = porContrato.get(String(candidata.cuota.contratoId)) ?? []
		lista.push(candidata)
		porContrato.set(String(candidata.cuota.contratoId), lista)
	}
	const seleccionadas: Candidata[] = []
	const descartadas = new Set<Candidata>()
	for (const [, lista] of porContrato) {
		lista.sort((a, b) => a.periodo.localeCompare(b.periodo))
		const limite = config.maxCuotasRecientes === null ? lista.length : Math.min(config.maxCuotasRecientes, lista.length)
		lista.slice(0, lista.length - limite).forEach(candidata => descartadas.add(candidata))
		lista.slice(lista.length - limite).forEach(candidata => seleccionadas.push(candidata))
	}
	for (const candidata of descartadas) {
		evaluadas.push({ cuota: candidata.cuota, resultado: 'limite_recientes', motivo: `se conservan las ${config.maxCuotasRecientes} cuotas mas recientes del contrato`, candidata })
	}

	// 4. Topes por corrida: lo que excede queda frenado, no se importa.
	seleccionadas.sort((a, b) => a.cuota.contratoId - b.cuota.contratoId || a.periodo.localeCompare(b.periodo))
	const admitidas: Candidata[] = []
	let facturas = 0
	let monto = 0
	for (const candidata of seleccionadas) {
		const pasaFacturas = config.maxFacturasNuevas === null || facturas < config.maxFacturasNuevas
		const pasaMonto = config.maxMontoNuevoCents === null || monto + candidata.montoCents <= config.maxMontoNuevoCents
		if (pasaFacturas && pasaMonto) {
			admitidas.push(candidata)
			facturas += 1
			monto += candidata.montoCents
		} else {
			evaluadas.push({
				cuota: candidata.cuota, resultado: 'frenada_tope',
				motivo: pasaFacturas
					? `supera el tope de USD ${((config.maxMontoNuevoCents ?? 0) / 100).toFixed(2)} por corrida`
					: `supera el tope de ${config.maxFacturasNuevas} facturas nuevas por corrida`,
				candidata,
			})
		}
	}

	for (const candidata of admitidas) evaluadas.push({ cuota: candidata.cuota, resultado: 'importada', motivo: 'cuota pendiente que cumple las reglas de importacion', candidata })
	return { evaluadas, candidatas: admitidas, erroresLectura }
}

/** Fila sintetica para poder registrar el detalle de un contrato que no se pudo leer. */
function filaVacia(id: number): CuotaPendiente {
	return {
		contratoId: id, codigo: '', identificacion: '', nombre: '', telefono: '', email: '', estado: '',
		plan: '', precioPlan: 0, moneda: '', monedaSigla: '', sucursal: '', deuda: 0, deudaId: '0', detalleDeuda: [],
	}
}

/** Escribe (o no, en simulacion) y arma los contadores y el detalle de la corrida. */
async function aplicar(
	almacen: Almacen, candidatas: readonly Candidata[], evaluadas: readonly Evaluada[],
	simulacion: boolean, corridaId: number,
): Promise<Contadores> {
	const contadores = { ...CONTADORES_VACIOS }
	// Los clientes nuevos se cuentan por documento, no por factura: un titular con tres
	// cuotas es un solo cliente nuevo.
	const clientesNuevos = new Set<string>()
	for (const candidata of candidatas) {
		if (!almacen.buscarCliente(candidata.cliente.documento)) clientesNuevos.add(candidata.cliente.documento)
	}
	contadores.clientesNuevos = clientesNuevos.size

	if (!simulacion) {
		for (const candidata of candidatas) {
			const existente = almacen.buscarCliente(candidata.cliente.documento)
			const clienteId = existente?.id ?? almacen.crearCliente(candidata.cliente)
			if (!existente) almacen.registrarEvento({ clienteId, tipo: 'cliente_creado', detalle: `cliente ${candidata.cliente.nombre} (${candidata.cliente.documento}) importado del administrador` })
			else almacen.actualizarCliente(clienteId, { nombre: candidata.cliente.nombre, email: candidata.cliente.email, telefono: candidata.cliente.telefono })
			const cuota = candidata.cuota
			almacen.guardarContrato({
				idExterno: String(cuota.contratoId), clienteId, estado: cuota.estado, plan: cuota.plan,
				precioCents: aCentavos(cuota.precioPlan), sucursal: cuota.sucursal, moneda: cuota.monedaSigla,
			})
			const facturaId = almacen.crearFactura({
				numero: almacen.siguienteNumeroFactura(), idExterno: cuota.deudaId, clienteId,
				contratoExterno: String(cuota.contratoId), periodo: candidata.periodo, vencimiento: candidata.vencimiento,
				corte: candidata.corte, totalCents: candidata.montoCents,
			})
			almacen.registrarEvento({
				clienteId, facturaId, tipo: 'factura_importada',
				detalle: `factura de la cuota ${cuota.deudaId} (${candidata.periodo}) del contrato ${cuota.contratoId}`,
			})
			contadores.importadas += 1
			contadores.montoImportadoCents += candidata.montoCents
		}
	} else {
		contadores.importadas = candidatas.length
		contadores.montoImportadoCents = candidatas.reduce((suma, candidata) => suma + candidata.montoCents, 0)
	}

	for (const evaluada of evaluadas) {
		if (evaluada.resultado === 'excluida_estado' || evaluada.resultado === 'moneda_no_admitida'
			|| evaluada.resultado === 'moneda_incoherente' || evaluada.resultado === 'identificacion_invalida'
			|| evaluada.resultado === 'sin_deuda' || evaluada.resultado === 'saldo_residual'
			|| evaluada.resultado === 'sin_periodo' || evaluada.resultado === 'fuera_ventana'
			|| evaluada.resultado === 'excluida_documento' || evaluada.resultado === 'contradiccion') contadores.excluidas += 1
		if (evaluada.resultado === 'frenada_tope' || evaluada.resultado === 'limite_recientes') contadores.frenadas += 1
		if (evaluada.resultado === 'ya_importada') contadores.yaImportadas += 1
		almacen.registrarItem(corridaId, {
			contratoExterno: String(evaluada.cuota.contratoId), cuotaId: evaluada.cuota.deudaId,
			clienteDocumento: evaluada.candidata?.cliente.documento ?? documentoDe(evaluada.cuota),
			clienteNombre: evaluada.candidata?.cliente.nombre ?? evaluada.cuota.nombre,
			resultado: evaluada.resultado, motivo: evaluada.motivo,
			montoCents: evaluada.candidata?.montoCents ?? aCentavos(evaluada.cuota.deuda),
			detalle: evaluada.cuota.detalleDeuda.join(' · '),
		})
	}
	contadores.cuotasRevisadas += evaluadas.length
	return contadores
}
