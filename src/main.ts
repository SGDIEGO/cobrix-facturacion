/**
 * Starts the test environment in one process:
 *   - the invoice manager API over data/billing-api.sqlite  (BILLING_API_PORT, default 4310)
 *   - the Cobrix panel + its own storage                     (PORT, default 4300)
 *
 * The provided database was generated for 2026-10-13. That date is pinned by default so
 * the acceptance numbers in docs/ENUNCIADO.md hold; set SANDBOX_TODAY to change it.
 */

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.SANDBOX_TODAY ??= '2026-10-13'

const { DEFAULT_BILLING_API_DB, seedBillingApi } = await import('./billing-api/seed.ts')
const { createBillingApiServer } = await import('./billing-api/server.ts')
const { createApp } = await import('./web/app.ts')
const { Almacen, ClienteApi, actualizarPagadas, crearPlanificador, importar } = await import('./cobrix/indice.ts')
const { today } = await import('./shared/dates.ts')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const billingApiDb = process.env.BILLING_API_DB ?? DEFAULT_BILLING_API_DB
const appPort = Number(process.env.PORT ?? 4300)
const billingApiPort = Number(process.env.BILLING_API_PORT ?? 4310)
const host = process.env.HOST ?? '127.0.0.1'

if (!existsSync(billingApiDb)) seedBillingApi(billingApiDb)

const billingApi = createBillingApiServer(billingApiDb)
await billingApi.listen(billingApiPort, host)
const simulatorUrl = `http://${host}:${billingApiPort}`

const almacen = new Almacen(resolve(root, 'data/cobrix.sqlite'))
const app = createApp({ simulatorUrl, assignmentPath: resolve(root, 'docs/ENUNCIADO.md') })
app.listen(appPort, host)

const planificador = crearPlanificador({
	almacen,
	log: mensaje => console.log(`[panel] ${mensaje}`),
	ejecutar: async () => {
		const proveedor = almacen.leerProveedor()
		const api = new ClienteApi({ baseUrl: proveedor.url, usuario: proveedor.usuario, password: proveedor.password })
		const hoy = today()
		await importar({ almacen, api, hoy, simulacion: false })
		await actualizarPagadas({ almacen, api, hoy, simulacion: false })
	},
})
planificador.iniciar()

console.log(`Panel (Cobrix):          http://${host}:${appPort}`)
console.log(`API del administrador:    ${simulatorUrl}/api/v1`)
console.log(`Swagger:                  ${simulatorUrl}/docs`)
console.log(`Fecha de la prueba:       ${process.env.SANDBOX_TODAY}`)

const shutdown = (): void => {
	planificador.detener()
	app.close()
	almacen.cerrar()
	void billingApi.close().then(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
