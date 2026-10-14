/**
 * Ciclo completo contra el administrador simulado: importar -> registrar pagos y una
 * anulacion en la caja del ISP -> actualizar pagadas. Comprueba los criterios de aceptacion
 * de docs/ENUNCIADO.md seccion 5.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { SANDBOX_API_USER, seedBillingApi } from '../src/billing-api/seed.ts'
import { createBillingApiServer, type BillingApiServer } from '../src/billing-api/server.ts'
import { Almacen } from '../src/cobrix/almacen.ts'
import { ClienteApi } from '../src/cobrix/clienteApi.ts'
import { importar } from '../src/cobrix/importar.ts'
import { actualizarPagadas } from '../src/cobrix/pagadas.ts'

process.env.SANDBOX_TODAY = '2026-10-13'
const HOY = '2026-10-13'

describe('ciclo completo de la integracion', () => {
	let dir: string
	let api: BillingApiServer
	let base: string
	let almacen: Almacen

	const cliente = (): ClienteApi =>
		new ClienteApi({ baseUrl: base, usuario: SANDBOX_API_USER.user_name, password: SANDBOX_API_USER.password })

	before(async () => {
		dir = mkdtempSync(join(tmpdir(), 'cobrix-ciclo-'))
		seedBillingApi(join(dir, 'billing-api.sqlite'))
		api = createBillingApiServer(join(dir, 'billing-api.sqlite'))
		base = `http://127.0.0.1:${await api.listen(0)}`
		almacen = new Almacen(join(dir, 'cobrix.sqlite'))
		almacen.guardarProveedor({ url: base, usuario: SANDBOX_API_USER.user_name, password: SANDBOX_API_USER.password })
	})

	after(async () => {
		almacen.cerrar()
		await api.close()
		// En Windows el WAL de SQLite a veces sigue bloqueado un instante: se ignora y listo.
		try {
			rmSync(dir, { recursive: true, force: true })
		} catch {
			// el directorio temporal lo limpia el sistema
		}
	})

	const simular = async (ruta: string, cuerpo: unknown): Promise<Record<string, unknown>> => {
		const respuesta = await fetch(`${base}${ruta}`, {
			method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo),
		})
		assert.equal(respuesta.status, 200, `${ruta} respondio ${respuesta.status}`)
		return await respuesta.json() as Record<string, unknown>
	}

	it('simular importacion: 42 cuotas y ni un registro creado', async () => {
		const simulacro = await importar({ almacen, api: cliente(), hoy: HOY, simulacion: true })
		assert.equal(simulacro.estado, 'COMPLETADA')
		assert.equal(simulacro.contadores.importadas, 42)
		assert.equal(simulacro.contadores.montoImportadoCents, 123_500)
		assert.equal(simulacro.contadores.clientesNuevos, 20)
		assert.equal(almacen.totales(HOY).clientes, 0, 'la simulacion no escribe nada')
		assert.equal(almacen.totales(HOY).facturasAbiertas, 0, 'la simulacion no escribe nada')
	})

	it('importar: 20 clientes, 42 facturas abiertas por USD 1.235,00', async () => {
		const corrida = await importar({ almacen, api: cliente(), hoy: HOY, simulacion: false })
		assert.equal(corrida.estado, 'COMPLETADA')
		assert.equal(corrida.contadores.importadas, 42)
		const totales = almacen.totales(HOY)
		assert.equal(totales.clientes, 20)
		assert.equal(totales.contratos, 21)
		assert.equal(totales.facturasAbiertas, 42)
		assert.equal(totales.facturasPagadas, 0)
		assert.equal(totales.porCobrarCents, 123_500)
	})

	it('volver a importar no duplica nada', async () => {
		const corrida = await importar({ almacen, api: cliente(), hoy: HOY, simulacion: false })
		assert.equal(corrida.contadores.importadas, 0)
		assert.equal(corrida.contadores.yaImportadas, 42)
		const totales = almacen.totales(HOY)
		assert.equal(totales.clientes, 20)
		assert.equal(totales.facturasAbiertas, 42)
	})

	it('los titulares excluidos no aparecen como clientes', () => {
		const documentos = almacen.listarClientes().map(cliente => cliente.nombre.toUpperCase())
		for (const ausente of ['CARLOS ROJAS', 'ROSA DIAZ', 'PEDRO LEON', 'ANDRES VARGAS', 'LAURA MENDEZ', 'JORGE CASTILLO']) {
			assert.ok(!documentos.includes(ausente), `${ausente} no deberia ser cliente`)
		}
		assert.ok(documentos.includes('ANA PEREZ'))
		assert.ok(documentos.includes('LUIS GOMEZ'))
	})

	it('un titular con dos contratos es un solo cliente, y ELENA RUIZ queda como 9000123', () => {
		const luis = almacen.listarClientes().find(cliente => cliente.nombre.toUpperCase() === 'LUIS GOMEZ')
		assert.ok(luis, 'LUIS GOMEZ deberia existir')
		assert.equal(luis.contratos, 2)
		assert.equal(luis.abiertas, 5)
		const elena = almacen.leerCliente('9000123')
		assert.ok(elena, 'ELENA RUIZ deberia tener el documento 9000123')
		assert.equal(almacen.contratosDeCliente(elena.id).length, 1)
	})

	it('la exclusion por estado, moneda incoherente y saldo residual quedan en el detalle', async () => {
		const corrida = await importar({ almacen, api: cliente(), hoy: HOY, simulacion: true })
		const items = almacen.itemsDeCorrida(corrida.corridaId)
		const cuenta = (resultado: string): number => items.filter(item => item.resultado === resultado).length
		assert.equal(cuenta('excluida_estado'), 9)
		assert.ok(cuenta('moneda_incoherente') >= 1, 'JORGE CASTILLO se descarta por moneda incoherente')
		assert.equal(cuenta('saldo_residual'), 1)
		assert.equal(cuenta('sin_deuda'), 1, 'LAURA MENDEZ devuelve la fila deuda_id 0')
	})

	it('pagos en la caja del ISP: 8 pagadas, 34 abiertas por USD 955,00', async () => {
		await simular('/__sim/pagar', { id_contrato: 900101 })
		await simular('/__sim/pagar', { id_contrato: 900103, monto: 25 })
		await simular('/__sim/pagar', { id_contrato: 900104 })
		await simular('/__sim/pagar', { id_contrato: 900114, monto: 70 })
		const anulable = await simular('/__sim/pagar', { id_contrato: 900113 })
		await simular('/__sim/anular', { id_factura: anulable.id_factura })

		const corrida = await actualizarPagadas({ almacen, api: cliente(), hoy: HOY, simulacion: false })
		assert.equal(corrida.estado, 'COMPLETADA')
		assert.equal(corrida.contadores.marcadasPagadas, 8)
		assert.equal(corrida.contadores.abonosParciales, 1, 'el pago parcial de LUIS GOMEZ se informa y sigue abierto')

		const totales = almacen.totales(HOY)
		assert.equal(totales.facturasPagadas, 8)
		assert.equal(totales.facturasAbiertas, 34)
		assert.equal(totales.porCobrarCents, 95_500)
	})

	it('la segunda actualizacion no cambia nada y la simulacion coincide con la real', async () => {
		const otra = await actualizarPagadas({ almacen, api: cliente(), hoy: HOY, simulacion: false })
		assert.equal(otra.contadores.marcadasPagadas, 0)
		const totales = almacen.totales(HOY)
		assert.equal(totales.facturasPagadas, 8)
		assert.equal(totales.facturasAbiertas, 34)
		const simulacro = await actualizarPagadas({ almacen, api: cliente(), hoy: HOY, simulacion: true })
		assert.equal(simulacro.contadores.marcadasPagadas, 0)
		assert.equal(simulacro.contadores.abonosParciales, 1)
	})

	it('las facturas de cada caso quedan en el estado esperado', async () => {
		const estadoDe = (nombre: string): { abiertas: number; pagadas: number } => {
			const clienteFila = almacen.listarClientes().find(fila => fila.nombre.toUpperCase() === nombre)
			assert.ok(clienteFila, `${nombre} deberia existir`)
			return { abiertas: clienteFila.abiertas, pagadas: clienteFila.pagadas }
		}
		assert.deepEqual(estadoDe('ANA PEREZ'), { abiertas: 0, pagadas: 3 })
		assert.deepEqual(estadoDe('LUIS GOMEZ'), { abiertas: 4, pagadas: 1 })
		assert.deepEqual(estadoDe('COMERCIAL EL FARO, C.A.'), { abiertas: 0, pagadas: 2 })
		assert.deepEqual(estadoDe('MIGUEL ANGEL SOTO'), { abiertas: 6, pagadas: 2 })
		assert.deepEqual(estadoDe('ELENA RUIZ'), { abiertas: 2, pagadas: 0 })
	})

	it('el historial del cliente registra creacion, importacion y pago', () => {
		const luis = almacen.leerCliente(almacen.listarClientes().find(fila => fila.nombre.toUpperCase() === 'ANA PEREZ')!.documento)
		assert.ok(luis)
		const eventos = almacen.eventosDeCliente(luis.id).map(evento => evento.tipo)
		assert.ok(eventos.includes('cliente_creado'))
		assert.ok(eventos.includes('factura_importada'))
		assert.ok(eventos.includes('factura_pagada'))
	})

	it('el almacen pagina: sin argumentos trae todo y con pagina y tamano pagina', () => {
		assert.equal(almacen.listarClientes().length, almacen.contarClientes(), 'sin paginar trae todo')
		assert.equal(almacen.listarClientes('', 1, 5).length, 5)
		assert.equal(almacen.listarClientes('', 4, 5).length, 5)
		assert.equal(almacen.listarClientes('', 5, 5).length, 0, 'pagina fuera de rango no trae nada')
		assert.equal(almacen.contarClientes('ELENA'), 1)
		assert.equal(almacen.listarClientes('elena', 1, 5).length, 1, 'la busqueda tambien pagina')

		const otra = new Almacen(join(dir, 'paginacion.sqlite'))
		const clienteId = otra.crearCliente({ documento: 'V10000000', nombre: 'PAGINADO', tipo: 'natural', email: '', telefono: '' })
		for (let i = 0; i < 7; i++) {
			const sufijo = String(1000 + i)
			otra.guardarContrato({ idExterno: sufijo, clienteId, estado: 'ACTIVO', plan: 'PLAN', precioCents: 1000, sucursal: 'CCS', moneda: 'USD' })
			otra.crearFactura({ numero: `COB-00000${i}`, idExterno: `9000${i}`, clienteId, contratoExterno: sufijo, periodo: '2026-01', vencimiento: '2026-01-01', corte: '2026-01-01', totalCents: 1000 })
		}
		assert.equal(otra.facturasDeCliente(clienteId).length, 7)
		assert.equal(otra.facturasDeCliente(clienteId, 1, 3).length, 3)
		assert.equal(otra.facturasDeCliente(clienteId, 3, 3).length, 1, 'la ultima pagina puede quedar corta')
		assert.equal(otra.contarFacturasCliente(clienteId), 7)
		otra.cerrar()
	})
	it('una corrida con credenciales malas queda registrada como fallida', async () => {
		const malas = new ClienteApi({ baseUrl: base, usuario: SANDBOX_API_USER.user_name, password: 'no-es-la-clave' })
		const corrida = await importar({ almacen, api: malas, hoy: HOY, simulacion: false })
		assert.equal(corrida.estado, 'FALLIDA')
		assert.match(corrida.error, /Contrase/i)
		const guardada = almacen.leerCorrida(corrida.corridaId)
		assert.equal(guardada?.estado, 'FALLIDA')
		assert.ok(guardada?.error.length)
	})
})
