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
		panel = createApp({ simulatorUrl: base, assignmentPath: fileURLToPath(new URL('../docs/ENUNCIADO.md', import.meta.url)) })
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

	it('el panel sirve el esqueleto y el enunciado, sin pantalla de simulador', async () => {
		for (const path of ['/', '/clientes', '/clientes/1', '/sincronizacion', '/configuracion']) {
			const body = await (await fetch(`${panelBase}${path}`)).text()
			assert.match(body, /Por implementar/, path)
		}
		assert.match(await (await fetch(`${panelBase}/enunciado`)).text(), /Criterios de aceptación/)
		assert.equal((await fetch(`${panelBase}/simulador`)).status, 404)
		assert.doesNotMatch(await (await fetch(`${panelBase}/`)).text(), /Simulador del administrador/)
	})
})
