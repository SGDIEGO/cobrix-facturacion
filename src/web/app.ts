/**
 * Panel skeleton of the test. Every Cobrix screen is a placeholder that lists what has to be
 * built. Payments on the ISP side are created through the API's /__sim routes (Swagger).
 *
 * Replace these placeholders with your implementation, or build the panel with your own
 * stack and keep this file only as a reference of the screens.
 */

import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { CSS, esc, html, layout, pill, type Raw, type Tone } from './layout.ts'

type Row = Record<string, unknown>

export interface AppDeps {
	/** The local invoice manager API. */
	readonly simulatorUrl: string
	/** Path of docs/ENUNCIADO.md, served at /enunciado. */
	readonly assignmentPath: string
}

interface Screen {
	readonly title: string
	readonly purpose: string
	readonly section: string
	readonly todo: readonly string[]
}

/** What each screen must do. Mirrors docs/ENUNCIADO.md. */
const SCREENS: Record<string, Screen> = {
	'/': {
		title: 'Resumen',
		purpose: 'Vista general de la integración con el administrador de facturas.',
		section: '3.8',
		todo: [
			'Totales: clientes importados, contratos, facturas abiertas y pagadas, monto por cobrar.',
			'Datos del proveedor configurado y si la corrida automática está activa.',
			'Últimas corridas con su resultado.',
			'Accesos rápidos a «Importar» y «Actualizar pagadas».',
		],
	},
	'/clientes': {
		title: 'Clientes',
		purpose: 'Tabla de los clientes importados desde el administrador.',
		section: '3.5',
		todo: [
			'Un cliente por cédula o RIF (los contratos del mismo titular se agrupan).',
			'Columnas: nombre, documento, tipo (natural o jurídico), contratos, facturas abiertas y pagadas, deuda y vencimiento más antiguo.',
			'Búsqueda por nombre, cédula o RIF.',
			'Cada fila abre el expediente del cliente.',
		],
	},
	'/clientes/expediente': {
		title: 'Expediente del cliente',
		purpose: 'Todo lo que Cobrix sabe de un cliente.',
		section: '3.6',
		todo: [
			'Datos del cliente: documento, correo, teléfono, origen.',
			'Contratos en el administrador con estado, plan y sucursal.',
			'Facturas: número de Cobrix, cuota del administrador, periodo, vencimiento, corte, total, saldo y estado.',
			'Historial: cliente creado, factura importada, factura pagada en el ISP.',
		],
	},
	'/sincronizacion': {
		title: 'Sincronización',
		purpose: 'Las dos corridas que traen los datos del administrador a Cobrix.',
		section: '3.2 a 3.4',
		todo: [
			'«Importar» y «Simular importación» (la simulación cuenta sin escribir nada).',
			'«Actualizar pagadas» y «Simular actualización».',
			'Historial de corridas: tipo, fecha, si fue simulación, estado y resultado.',
			'Detalle de cada corrida: contadores y una fila por cuota con su resultado y motivo.',
		],
	},
	'/configuracion': {
		title: 'Configuración',
		purpose: 'Datos de la empresa y del proveedor.',
		section: '3.1',
		todo: [
			'Empresa: nombre, RIF y correo de cobranza.',
			'Proveedor: URL de la API, usuario y contraseña, con un botón «Probar conexión».',
			'Estados de contrato que se importan (por defecto ACTIVO y CORTADO).',
			'Ventana de importación, máximo de cuotas recientes, días de gracia, topes por corrida y exclusión por tipo de documento.',
			'Corrida automática diaria a una hora elegida.',
		],
	},
}

export function createApp(deps: AppDeps): Server {
	function placeholder(path: string): Raw {
		const screen = SCREENS[path]!
		return html`
			<div class="head"><div><h1>${screen.title} ${pill('Por implementar', 'warn')}</h1><p>${screen.purpose}</p></div></div>
			<section class="card"><header><h2>Qué debe hacer esta pantalla</h2><a href="/enunciado">Enunciado §${screen.section}</a></header>
				<div class="body"><ul class="todo">${screen.todo.map(item => html`<li>${item}</li>`)}</ul></div></section>
			${path === '/' ? html`
				<section class="card"><header><h2>Cómo empezar</h2></header><div class="body"><ol class="todo">
					<li>Lee el <a href="/enunciado">enunciado</a>: qué construir, reglas y criterios de aceptación.</li>
					<li>Explora la API en <a href="${deps.simulatorUrl}/docs" target="_blank" rel="noopener">Swagger</a> (usuario <span class="mono">cobrix</span>, contraseña <span class="mono">cobrix-sandbox</span>).</li>
					<li>Para crear pagos del lado del ISP y probar tu «Actualizar pagadas», usa la sección <strong>Simulador</strong> del Swagger (<span class="mono">POST /__sim/pagar</span>).</li>
					<li>Implementa las pantallas de este menú.</li>
				</ol></div></section>` : ''}`
	}

	function assignmentPage(): Raw {
		let text = ''
		try {
			text = readFileSync(deps.assignmentPath, 'utf8')
		} catch {
			text = 'No se encontró docs/ENUNCIADO.md.'
		}
		return html`<div class="head"><div><h1>Enunciado</h1><p>También en <span class="mono">docs/ENUNCIADO.md</span>.</p></div></div>
			<section class="card"><div class="body"><pre class="doc">${text}</pre></div></section>`
	}

	async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://prueba.local')
		const path = url.pathname.replace(/\/+$/, '') || '/'
		const text = url.searchParams.get('msg')
		const tone = url.searchParams.get('tone') as Tone | null
		const flash = text && tone ? { tone, text } : undefined
		const company = 'Tu empresa (por configurar)'
		const page = (title: string, active: string, body: Raw) => sendHtml(res, 200, layout({ title, active, body, flash, company }))

		if (req.method === 'GET') {
			if (path === '/app.css') return send(res, 200, CSS + SKELETON_CSS, 'text/css; charset=utf-8')
			if (path === '/enunciado') return page('Enunciado', '', assignmentPage())
			if (/^\/clientes\/[^/]+$/.test(path)) return page('Expediente', '/clientes', placeholder('/clientes/expediente'))
			if (SCREENS[path]) return page(SCREENS[path].title, path, placeholder(path))
		}
			sendHtml(res, 404, layout({ title: 'No encontrado', active: '', company, body: html`<h1>No encontrado</h1><p><a href="/">Volver</a></p>` }))
	}

	return createServer((req, res) => {
		route(req, res).catch((error: unknown) => {
			console.error('[panel]', error)
			if (!res.headersSent) sendHtml(res, 500, layout({ title: 'Error', active: '', company: '', body: html`<h1>Algo falló</h1><p class="muted">${esc(error instanceof Error ? error.message : error)}</p>` }))
		})
	})
}

const SKELETON_CSS = `
ul.todo, ol.todo { margin: 0; padding-left: 20px; display: grid; gap: 6px; max-width: 90ch; }
pre.doc { margin: 0; white-space: pre-wrap; font: 13.5px/1.6 var(--mono); color: var(--fg); max-width: 110ch; }
`

function sendHtml(res: ServerResponse, status: number, body: string): void {
	send(res, status, body, 'text/html; charset=utf-8')
}

function send(res: ServerResponse, status: number, body: string, type: string): void {
	res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) })
	res.end(body)
}
