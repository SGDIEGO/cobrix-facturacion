/**
 * Checks the environment handed to the candidate: the API answers as documented, every
 * documented route exists and the panel skeleton serves its screens.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'

import { SANDBOX_API_USER, seedBillingApi } from '../src/billing-api/seed.ts'
import { createBillingApiServer, type BillingApiServer } from '../src/billing-api/server.ts'
import { createApp } from '../src/web/app.ts'

process.env.SANDBOX_TODAY = '2026-10-13'

describe('entorno de la prueba', () => {
	let dir: string
	let api: BillingApiServer
	let base: string
	let panel: ReturnType<typeof createApp>
	let panelBase: string

	before(async () => {
		dir = mkdtempSync(join(tmpdir(), 'prueba-facturacion-'))
		seedBillingApi(join(dir, 'billing-api.sqlite'))
		api = createBillingApiServer(join(dir, 'billing-api.sqlite'))
		base = `http://127.0.0.1:${await api.listen(0)}`
		panel = createApp({ simulatorUrl: base, assignmentPath: fileURLToPath(new URL('../docs/ENUNCIADO.md', import.meta.url)), almacenPath: join(dir, 'panel.sqlite') })
		await new Promise<void>(resolve => panel.listen(0, '127.0.0.1', resolve))
		const address = panel.address()
		panelBase = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
	})

	after(async () => {
		await new Promise(resolve => panel.close(resolve))
		await api.close()
		rmSync(dir, { recursive: true, force: true })
	})

	it('login, lista de contratos y cuotas de un contrato', async () => {
		const login = await (await fetch(`${base}/api/v1/usuario/login`, { method: 'POST', body: JSON.stringify({ user_name: SANDBOX_API_USER.user_name, password: SANDBOX_API_USER.password }) })).json() as Record<string, string>
		const auth = { authorization: `Bearer ${login.access_token}` }
		const ids = await (await fetch(`${base}/api/v1/isp/lista_ids_contratos`, { headers: auth })).json() as { data: number[] }
		assert.equal(ids.data.length, 27)
		const rows = await (await fetch(`${base}/api/v1/isp/contrato/individual?id_contrato=900101`, { headers: auth })).json() as Array<Record<string, unknown>>
		assert.ok(rows.length > 0)
		assert.equal(rows[0]!.contrato_id, 900101)
	})

	it('cada ruta documentada en Swagger existe', async () => {
		const spec = await (await fetch(`${base}/openapi.json`)).json() as { paths: Record<string, Record<string, unknown>> }
		for (const [path, methods] of Object.entries(spec.paths)) {
			for (const method of Object.keys(methods)) {
				if (path === '/__sim/reiniciar') continue
				const response = await fetch(`${base}${path}`, { method: method.toUpperCase(), ...(method === 'post' ? { body: '{}' } : {}) })
				assert.ok(![404, 405].includes(response.status), `${method} ${path}`)
			}
		}
	})

	it('tras una accion el panel redirige a la corrida (F5 no la repite)', async () => {
		const respuesta = await fetch(`${panelBase}/acciones/simular-importar`, { method: 'POST', body: '', redirect: 'manual' })
		assert.equal(respuesta.status, 303, 'POST -> Redirect -> GET')
		assert.match(respuesta.headers.get('location') ?? '', /^\/sincronizacion\/\d+\?mensaje=/)
	})

	it('los enlaces de orden son absolutos, no relativos', async () => {
		// Relativos resolverian contra /acciones/... y darian 404 tras sincronizar.
		const cuerpo = await (await fetch(`${panelBase}/clientes`)).text()
		assert.doesNotMatch(cuerpo, /<a href="\?orden=/, 'los enlaces de orden deben llevar la ruta')
		assert.match(cuerpo, /href="\/clientes\?orden=/)
	})

	it('configurar, importar y filtrar el detalle de una corrida', async () => {
		const formulario = new URLSearchParams({
			nombre: 'ISP DE PRUEBA', rif: 'J-00000000-0', correo: 'cobranza@example.com',
			url: base, usuario: SANDBOX_API_USER.user_name, password: SANDBOX_API_USER.password,
			estado_ACTIVO: 'on', estado_CORTADO: 'on', ventana: 'todas', recientes: '',
			diasGracia: '0', maxFacturas: '', maxMonto: '', hora: '02:00',
		})
		const guardar = await fetch(`${panelBase}/configuracion`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: formulario })
		assert.equal(guardar.status, 200)
		assert.match(await guardar.text(), /Configuracion guardada/)

		const accion = await fetch(`${panelBase}/acciones/importar`, { method: 'POST', body: '', redirect: 'manual' })
		assert.equal(accion.status, 303)
		const destino = accion.headers.get('location') ?? ''
		const id = Number(/\/sincronizacion\/(\d+)/.exec(destino)?.[1])
		assert.ok(id > 0, 'el redirect apunta a una corrida')

		const todos = await (await fetch(`${panelBase}/sincronizacion/${id}`)).text()
		assert.match(todos, /Todos los resultados/)
		assert.match(todos, /Ordenar por Contrato/)
		assert.match(todos, /class="ordenable /)

		const soloImportadas = await (await fetch(`${panelBase}/sincronizacion/${id}?resultado=importada`)).text()
		assert.match(soloImportadas, /42 filas \(filtradas\)/, 'el filtro deja solo las importadas')
		assert.doesNotMatch(soloImportadas, /class="pill mute">excluida estado<\/span><\/td>/)

		const conTexto = await (await fetch(`${panelBase}/sincronizacion/${id}?q=zzzz`)).text()
		assert.match(conTexto, /Ninguna fila coincide con el filtro/)

		const clientes = await (await fetch(`${panelBase}/clientes?q=ELENA`)).text()
		assert.match(clientes, /ELENA RUIZ/)
	})

	it('la conciliacion, el CSV y la salud responden', async () => {
		await fetch(`${panelBase}/acciones/importar`, { method: 'POST', body: '', redirect: 'manual' })
		const conciliar = await fetch(`${panelBase}/acciones/conciliar`, { method: 'POST', body: '', redirect: 'manual' })
		assert.equal(conciliar.status, 303)
		assert.match(conciliar.headers.get('location') ?? '', /^\/conciliacion/)

		const pantalla = await (await fetch(`${panelBase}/conciliacion`)).text()
		assert.match(pantalla, /Contratos revisados/)
		assert.match(pantalla, /Futuras/)
		assert.match(pantalla, /Ya cobradas/)

		const clientes = await fetch(`${panelBase}/export/clientes.csv`)
		assert.equal(clientes.status, 200)
		assert.match(clientes.headers.get('content-type') ?? '', /text\/csv/)
		assert.match(clientes.headers.get('content-disposition') ?? '', /clientes\.csv/)
		const csv = await clientes.text()
		assert.match(csv, /Documento;Nombre;Tipo;Contratos/)
		assert.ok(csv.split('\r\n').length > 1, 'trae filas')

		const facturas = await fetch(`${panelBase}/export/clientes/V12345678.csv`)
		assert.equal(facturas.status, 200)
		assert.match(await facturas.text(), /Factura;Cuota;Contrato;Periodo/)

		const conciliado = await fetch(`${panelBase}/export/conciliacion.csv`)
		assert.equal(conciliado.status, 200)

		const salud = await (await fetch(`${panelBase}/salud`)).json() as Record<string, unknown>
		assert.equal(salud.estado, 'ok')
		assert.equal(salud.hoy, '2026-10-13')
		assert.ok(salud.totales, 'trae los totales')
		assert.ok(salud.ultimaCorrida, 'trae la ultima corrida')
	})

	it('el panel sirve sus pantallas y el enunciado, sin pantalla de simulador', async () => {
		for (const path of ['/', '/clientes', '/clientes/1', '/sincronizacion', '/configuracion']) {
			const body = await (await fetch(`${panelBase}${path}`)).text()
			assert.doesNotMatch(body, /Por implementar/, path)
		}
		assert.match(await (await fetch(`${panelBase}/enunciado`)).text(), /Criterios de aceptación/)
		assert.equal((await fetch(`${panelBase}/simulador`)).status, 404)
		assert.doesNotMatch(await (await fetch(`${panelBase}/`)).text(), /Simulador del administrador/)
	})
})
