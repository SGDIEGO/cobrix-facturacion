/**
 * Panel de Cobrix para operar la integracion con el administrador de facturas del ISP.
 *
 * Pantallas: Resumen, Clientes, Expediente del cliente, Sincronizacion y Configuracion.
 * Las corridas viven en `src/cobrix/`; este archivo las dispone y las muestra.
 *
 * Ademas: paginacion en todas las tablas largas, leyendas de resultados y estados, iconos de
 * FontAwesome (servidos localmente desde `src/web/assets`) y textos de ayuda donde hace falta.
 */

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { Almacen } from '../cobrix/almacen.ts'
import { ClienteApi } from '../cobrix/clienteApi.ts'
import { importar } from '../cobrix/importar.ts'
import { actualizarPagadas } from '../cobrix/pagadas.ts'
import { today } from '../shared/dates.ts'
import { configDesdeFormulario, describirConfig, empresaDesdeFormulario, proveedorDesdeFormulario } from '../cobrix/formularios.ts'
import type { ResultadoCuota } from '../cobrix/tipos.ts'
import { CSS, dateTime, date, esc, icon, html, layout, pill, usd, type Raw, type Tone } from './layout.ts'

export interface AppDeps {
	/** El administrador de facturas simulado (mismo proceso, pero se habla por HTTP). */
	readonly simulatorUrl: string
	/** Path de docs/ENUNCIADO.md, servido en /enunciado. */
	readonly assignmentPath: string
	/** Base de Cobrix. */
	readonly almacenPath?: string
}

const RAIZ = resolve('.')
const TAMANOS = [20, 25, 50]
const TAMANO_POR_DEFECTO = 20

let almacenGlobal: Almacen | null = null
function almacenDe(deps: AppDeps): Almacen {
	if (!almacenGlobal) almacenGlobal = new Almacen(deps.almacenPath ?? 'data/cobrix.sqlite')
	return almacenGlobal
}

function apiDe(almacen: Almacen, urlBase: string): ClienteApi {
	const proveedor = almacen.leerProveedor()
	return new ClienteApi({ baseUrl: proveedor.url || urlBase, usuario: proveedor.usuario, password: proveedor.password })
}

interface Flash {
	readonly tone: Tone
	readonly text: string
	readonly html?: Raw
}

/** Pagina actual dentro de una tabla larga. */
interface Pagina {
	readonly numero: number
	readonly tamano: number
	readonly total: number
	get totalPaginas(): number
	get desde(): number
	get hasta(): number
}

function pagina(numero: number, tamano: number, total: number): Pagina {
	return {
		numero: Math.max(1, Math.min(numero, Math.max(1, Math.ceil(total / tamano)))),
		tamano, total,
		get totalPaginas() { return Math.max(1, Math.ceil(this.total / this.tamano)) },
		get desde() { return this.total === 0 ? 0 : (this.numero - 1) * this.tamano + 1 },
		get hasta() { return Math.min(this.total, this.numero * this.tamano) },
	}
}

/** 1 2 3 … 10 con puntos suspensivos cuando hay muchas paginas. */
function numerosPagina(actual: number, total: number): Array<number | null> {
	if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
	const salida: Array<number | null> = [1]
	const alrededor = [actual - 1, actual, actual + 1].filter(n => n > 1 && n < total)
	salida.push(...alrededor.map(n => n))
	if (!salida.includes(total)) salida.push(total)
	const ordenado = [...new Set(salida)].sort((a, b) => (a ?? 0) - (b ?? 0))
	const conSaltos: Array<number | null> = []
	for (let i = 0; i < ordenado.length; i++) {
		if (i > 0 && ordenado[i]! - ordenado[i - 1]! > 1) conSaltos.push(null)
		conSaltos.push(ordenado[i]!)
	}
	return conSaltos
}

function controlesPaginacion(base: string, buscar: URLSearchParams, info: Pagina): Raw {
	const totalPaginas = info.totalPaginas
	const enlace = (pagina: number): string => {
		const params = new URLSearchParams(buscar)
		params.set('pagina', String(pagina))
		if (info.tamano !== TAMANO_POR_DEFECTO) params.set('tamano', String(info.tamano))
		else params.delete('tamano')
		const query = params.toString()
		return `${base}${query ? `?${query}` : ''}`
	}
	if (totalPaginas <= 1 && TAMANOS.every(tamano => tamano === info.tamano)) {
		return html`<p class="muted">Mostrando ${info.total} ${info.total === 1 ? 'registro' : 'registros'}.</p>`
	}
	return html`
		<div class="paginacion">
			<span class="info">Mostrando ${info.desde}–${info.hasta} de ${info.total}</span>
			<nav class="paginas" aria-label="Paginacion">
				<a class="${info.numero === 1 ? 'disabled' : ''}" href="${info.numero === 1 ? '#' : enlace(1)}" aria-label="Primera pagina" ${info.numero === 1 ? 'aria-disabled="true"' : ''}>${icon('angles-left')}</a>
				<a class="${info.numero === 1 ? 'disabled' : ''}" href="${info.numero === 1 ? '#' : enlace(info.numero - 1)}" aria-label="Pagina anterior" ${info.numero === 1 ? 'aria-disabled="true"' : ''}>${icon('angle-left')}</a>
				${numerosPagina(info.numero, totalPaginas).map(numero => numero === null
					? html`<span class="salto" aria-hidden="true">…</span>`
					: html`<a class="${numero === info.numero ? 'activa' : ''}" href="${enlace(numero)}" ${numero === info.numero ? 'aria-current="page"' : ''}>${numero}</a>`)}
				<a class="${info.numero === totalPaginas ? 'disabled' : ''}" href="${info.numero === totalPaginas ? '#' : enlace(info.numero + 1)}" aria-label="Pagina siguiente" ${info.numero === totalPaginas ? 'aria-disabled="true"' : ''}>${icon('angle-right')}</a>
				<a class="${info.numero === totalPaginas ? 'disabled' : ''}" href="${info.numero === totalPaginas ? '#' : enlace(totalPaginas)}" aria-label="Ultima pagina" ${info.numero === totalPaginas ? 'aria-disabled="true"' : ''}>${icon('angles-right')}</a>
			</nav>
			<form class="tamano" method="get" action="${base}">
				${[...buscar.entries()].filter(([clave]) => !['pagina', 'tamano'].includes(clave)).map(([clave, valor]) => html`<input type="hidden" name="${clave}" value="${valor}">`)}
				<label for="tamano">Filas por pagina</label>
				<select id="tamano" name="tamano" onchange="this.form.submit()">
					${TAMANOS.map(valor => html`<option value="${valor}" ${valor === info.tamano ? 'selected' : ''}>${valor}</option>`)}
				</select>
			</form>
		</div>`
}

const TIPOS_MIME: Record<string, string> = {
	'.css': 'text/css; charset=utf-8',
	'.woff2': 'font/woff2',
	'.woff': 'font/woff',
	'.ttf': 'font/ttf',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
}

function servirAsset(res: ServerResponse, ruta: string): boolean {
	if (ruta.includes('..')) return false
	const relativa = ruta.replace(/^\/+/, '').split('/').join('\\')
	const archivo = join(RAIZ, 'src', 'web', relativa)
	if (!existsSync(archivo) || !statSync(archivo).isFile()) return false
	const tipo = TIPOS_MIME[extname(archivo)] ?? 'application/octet-stream'
	res.writeHead(200, {
		'content-type': tipo,
		'content-length': statSync(archivo).size,
		'cache-control': 'public, max-age=86400',
	})
	createReadStream(archivo).pipe(res)
	return true
}

export function createApp(deps: AppDeps): Server {
	const almacen = almacenDe(deps)

	function sendHtml(res: ServerResponse, status: number, body: string): void {
		res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) })
		res.end(body)
	}

	function leerCuerpo(req: IncomingMessage): Promise<Record<string, string | undefined>> {
		return new Promise((resolver, rechazar) => {
			const trozos: Buffer[] = []
			req.on('data', (trozo: Buffer) => trozos.push(trozo))
			req.on('end', () => {
				const params = new URLSearchParams(Buffer.concat(trozos).toString('utf8'))
				const entrada: Record<string, string | undefined> = {}
				for (const [clave, valor] of params) entrada[clave] = valor
				resolver(entrada)
			})
			req.on('error', rechazar)
		})
	}

	function cabecera(titulo: string, activo: string, body: Raw, flash?: Flash | undefined): string {
		return layout({ title: titulo, active: activo, body, flash, company: almacen.leerEmpresa().nombre || 'Cobrix' })
	}

	const nota = (texto: string): Raw => html`<p class="nota">${icon('circle-info')}<span>${texto}</span></p>`

	// ---------------------------------------------------------------- Resumen

	function resumen(flash?: Flash | undefined): Raw {
		const totales = almacen.totales(today())
		const proveedor = almacen.leerProveedor()
		const config = almacen.leerConfig()
		const corridas = almacen.ultimasCorridas()
		const deudores = almacen.clientesConCuotasVencidas(today())
		const tiles = [
			{ label: 'Clientes', icono: 'users', valor: String(totales.clientes), href: '/clientes' },
			{ label: 'Contratos importados', icono: 'file-contract', valor: String(totales.contratos), href: '/clientes' },
			{ label: 'Facturas abiertas', icono: 'file-invoice-dollar', valor: String(totales.facturasAbiertas), href: '/clientes' },
			{ label: 'Facturas pagadas', icono: 'circle-check', valor: String(totales.facturasPagadas), href: '/clientes' },
			{ label: 'Por cobrar', icono: 'sack-dollar', valor: usd(totales.porCobrarCents), href: '/clientes', destacado: totales.porCobrarCents > 0 },
			{ label: 'Vencidas', icono: 'triangle-exclamation', valor: String(totales.vencidas), href: '/clientes' },
		]

		const cuerpo = totales.clientes === 0
			? html`
				<section class="tiles">${tiles.map(tile => html`
					<a class="tile" href="${tile.href}"><span>${icon(tile.icono)}${tile.label}</span><strong>${tile.valor}</strong></a>`)}
				</section>
				<section class="card"><div class="body">
					<div class="empty">
						<h3>${icon('inbox')}Aun no hay clientes importados</h3>
						<p>Conecta el proveedor en <a href="/configuracion">Configuracion</a> (pulsa <em>Probar conexion</em>)
						y despues importa. Puedes empezar por <em>Simular importacion</em> para ver cuantas cuotas entrarian sin escribir nada.</p>
						<div class="acciones">
							<form method="post" action="/acciones/importar" onsubmit="return confirm('Importar clientes y facturas nuevas desde el administrador?')">
								<button class="btn primary" type="submit">${icon('file-import')}Importar</button>
							</form>
							<form method="post" action="/acciones/simular-importar">
								<button class="btn" type="submit">${icon('flask')}Simular importacion</button>
							</form>
							<form method="post" action="/acciones/pagadas">
								<button class="btn" type="submit">${icon('money-bill-wave')}Actualizar pagadas</button>
							</form>
						</div>
					</div>
				</div></section>`
			: html`
				<section class="tiles">${tiles.map(tile => html`
					<a class="tile" href="${tile.href}"><span>${icon(tile.icono)}${tile.label}</span><strong>${tile.valor}</strong></a>`)}
				</section>`

		return html`
			${cuerpo}
			<section class="card">
				<header><h2>${icon('server')}Proveedor</h2><a class="btn small" href="/configuracion">${icon('sliders')}Configurar</a></header>
				<div class="body">
					${proveedor.url
						? html`<dl class="facts">
							<dt>Administrador</dt><dd>${esc(proveedor.url)}</dd>
							<dt>Usuario</dt><dd>${esc(proveedor.usuario)}</dd>
							<dt>Fecha del sandbox</dt><dd>${date(today())}</dd>
							<dt>Documentacion de la API</dt><dd><a href="${deps.simulatorUrl}/docs" target="_blank" rel="noopener">Swagger</a> · <a href="${deps.simulatorUrl}/openapi.json" target="_blank" rel="noopener">openapi.json</a></dd>
							<dt>Importacion</dt><dd>${esc(describirConfig(config))}</dd>
							${config.corridaAutomatica
								? html`<dt>Corrida automatica</dt><dd>${pill('activa', 'ok')} a las ${esc(config.horaCorrida)} (America/Caracas)</dd>`
								: html`<dt>Corrida automatica</dt><dd>${pill('inactiva', 'mute')}</dd>`}
						</dl>`
						: html`<div class="empty"><p>El proveedor no esta configurado.
							<a href="/configuracion">Ir a Configuracion</a>.</p></div>`}
				</div>
			</section>
			${deudores.length > 0 ? html`
				<section class="card">
					<header><h2>${icon('hand-holding-dollar')}Cobro pendiente</h2><a class="btn small" href="/clientes">Ver clientes</a></header>
					<div class="table-wrap"><table>
						<thead><tr><th>Cliente</th><th class="num">Vencidas</th><th class="num">Deuda</th></tr></thead>
						<tbody>${deudores.map(deudor => html`
							<tr><td><a href="/clientes/${encodeURIComponent(deudor.documento)}">${esc(deudor.nombre)}</a></td>
							<td class="num">${deudor.vencidas}</td><td class="num dinero">${usd(deudor.deudaCents)}</td></tr>`)}
						</tbody>
					</table></div>
					${nota('Ordenado por deuda. Son los clientes con cuotas vencidas: lo primero que hay que cobrar.')}
				</section>` : ''}
			<section class="card">
				<header><h2>${icon('clock-rotate-left')}Ultimas corridas</h2><a class="btn small" href="/sincronizacion">Ver todas</a></header>
				<div class="table-wrap"><table>
					<thead><tr><th>#</th><th>Tipo</th><th>Inicio</th><th>Estado</th><th>Resultado</th></tr></thead>
					<tbody>${corridas.length === 0
						? html`<tr class="empty-row"><td colspan="5">Todavia no hay corridas. Corre una importacion para empezar.</td></tr>`
						: corridas.map(corrida => html`
							<tr>
								<td class="mono">${corrida.id}</td>
								<td>${corrida.tipo === 'IMPORTACION' ? 'Importacion' : 'Pagadas'}${corrida.simulacion ? ' ' + pill('simulada', 'info') : ''}</td>
								<td>${dateTime(corrida.iniciadaEn)}</td>
								<td>${corrida.estado === 'FALLIDA' ? pill('fallida', 'bad') : pill('completada', 'ok')}</td>
								<td class="muted">${resumenCorrida(corrida)}${corrida.error ? html` <span class="bad">${esc(corrida.error)}</span>` : ''}</td>
							</tr>`)}
					</tbody>
				</table></div>
			</section>
			<section class="card"><div class="body">
				<h2>${icon('bolt')}Acciones rapidas</h2>
				<div class="acciones">
					<form method="post" action="/acciones/importar" onsubmit="return confirm('Importar clientes y facturas nuevas desde el administrador?')">
						<button class="btn primary" type="submit">${icon('file-import')}Importar</button>
					</form>
					<form method="post" action="/acciones/pagadas">
						<button class="btn" type="submit">${icon('money-bill-wave')}Actualizar pagadas</button>
					</form>
				</div>
			</div></section>`
	}

	function resumenCorrida(corrida: { tipo: string; resumen: { importadas: number; yaImportadas: number; marcadasPagadas: number; abonosParciales: number } }): string {
		const r = corrida.resumen
		if (corrida.tipo === 'IMPORTACION') {
			if (r.importadas === 0 && r.yaImportadas === 0) return 'sin cambios'
			return `${r.importadas} nuevas · ${r.yaImportadas} ya importadas`
		}
		return `${r.marcadasPagadas} pagadas · ${r.abonosParciales} abono parcial`
	}

	// ---------------------------------------------------------------- Clientes

	function clientes(buscar: URLSearchParams, flash?: Flash | undefined): Raw {
		const busqueda = buscar.get('q') ?? ''
		const total = almacen.contarClientes(busqueda)
		const tamano = Math.max(1, Number(buscar.get('tamano')) || TAMANO_POR_DEFECTO)
		const info = pagina(Number(buscar.get('pagina')) || 1, tamano, total)
		const lista = almacen.listarClientes(busqueda, info.numero, info.tamano)

		return html`
			<section class="card"><div class="body">
				<form class="search" method="get" action="/clientes">
					<input type="search" name="q" value="${esc(busqueda)}" placeholder="Nombre, cedula o RIF" aria-label="Buscar clientes">
					<button class="btn" type="submit">${icon('magnifying-glass')}Buscar</button>
					${busqueda ? html`<a class="btn" href="/clientes">${icon('xmark')}Limpiar</a>` : ''}
					<input type="hidden" name="tamano" value="${info.tamano}">
				</form>
			</div></section>
			<section class="card">
				<header><h2>${icon('users')}Clientes</h2><span class="muted">${total} en total</span></header>
				<div class="table-wrap"><table>
					<thead><tr>
						<th>Nombre</th><th>Documento</th><th>Tipo</th>
						<th class="num">Contratos</th><th class="num">Abiertas</th><th class="num">Pagadas</th>
						<th class="num">Deuda</th><th>Vence la mas antigua</th>
					</tr></thead>
					<tbody>${lista.length === 0
						? html`<tr class="empty-row"><td colspan="8">${busqueda ? `Ningun cliente coincide con "${esc(busqueda)}". Prueba con menos letras o busca por documento.` : 'Aun no hay clientes. Corre una importacion para traerlos.'}</td></tr>`
						: lista.map(cliente => html`
							<tr>
								<td><a href="/clientes/${encodeURIComponent(cliente.documento)}"><strong>${esc(cliente.nombre)}</strong></a></td>
								<td class="mono">${esc(cliente.documento)}</td>
								<td>${cliente.tipo === 'juridica' ? pill('juridica', 'info') : 'Natural'}</td>
								<td class="num">${cliente.contratos}</td>
								<td class="num">${cliente.abiertas}</td>
								<td class="num">${cliente.pagadas}</td>
								<td class="num dinero">${usd(cliente.deudaCents)}</td>
								<td>${cliente.vencimientoMasAntiguo ? date(cliente.vencimientoMasAntiguo) : 'Al dia'}</td>
							</tr>`)}
					</tbody>
				</table></div>
				${controlesPaginacion('/clientes', buscar, info)}
			</section>`
	}

	// ---------------------------------------------------------------- Expediente

	function expediente(documento: string, buscar: URLSearchParams, flash?: Flash | undefined): Raw {
		const cliente = almacen.leerCliente(documento)
		if (!cliente) {
			return html`<div class="empty"><h3>${icon('user-slash')}Cliente no encontrado</h3>
				<p>El documento <span class="mono">${esc(documento)}</span> no esta en Cobrix.
				<a href="/clientes">Volver a Clientes</a>.</p></div>`
		}
		const contratos = almacen.contratosDeCliente(cliente.id)
		const totalFacturas = almacen.contarFacturasCliente(cliente.id)
		const totalEventos = almacen.contarEventosCliente(cliente.id)
		const tamano = Math.max(1, Number(buscar.get('tamano')) || TAMANO_POR_DEFECTO)
		const paginaFacturas = pagina(Number(buscar.get('facturas')) || 1, tamano, totalFacturas)
		const paginaEventos = pagina(Number(buscar.get('eventos')) || 1, tamano, totalEventos)
		const facturas = almacen.facturasDeCliente(cliente.id, paginaFacturas.numero, paginaFacturas.tamano)
		const eventos = almacen.eventosDeCliente(cliente.id, paginaEventos.numero, paginaEventos.tamano)
		const todas = almacen.facturasDeCliente(cliente.id)
		const abiertas = todas.filter(factura => factura.estado === 'ABIERTA')
		const pagadas = todas.filter(factura => factura.estado === 'PAGADA')
		const deuda = abiertas.reduce((suma, factura) => suma + factura.saldoCents, 0)

		return html`
			<div class="head"><div><h1>${esc(cliente.nombre)}</h1>
				<p><a href="/clientes">${icon('angle-left')} Clientes</a> · ${cliente.tipo === 'juridica' ? 'Persona juridica' : 'Persona natural'} · <span class="mono">${esc(cliente.documento)}</span></p></div></div>
			<section class="tiles">
				<div class="tile featured"><span>${icon('sack-dollar')}Deuda</span><strong>${usd(deuda)}</strong></div>
				<div class="tile"><span>${icon('file-invoice-dollar')}Facturas abiertas</span><strong>${abiertas.length}</strong></div>
				<div class="tile"><span>${icon('circle-check')}Facturas pagadas</span><strong>${pagadas.length}</strong></div>
				<div class="tile"><span>${icon('file-contract')}Contratos</span><strong>${contratos.length}</strong></div>
			</section>
			<div class="grid2 datos-contratos">
				<section class="card"><header><h2>${icon('id-card')}Datos del cliente</h2></header><div class="body">
					<dl class="facts">
						<dt>Documento</dt><dd class="mono">${esc(cliente.documento)}</dd>
						<dt>Tipo</dt><dd>${cliente.tipo === 'juridica' ? 'Persona juridica' : 'Persona natural'}</dd>
						<dt>Correo</dt><dd>${esc(cliente.email) || '—'}</dd>
						<dt>Telefono</dt><dd>${esc(cliente.telefono) || '—'}</dd>
						<dt>Origen</dt><dd>${esc(cliente.origen)}</dd>
						<dt>Creado</dt><dd>${dateTime(cliente.creadoEn)}</dd>
					</dl>
				</div></section>
				<section class="card"><header><h2>${icon('file-contract')}Contratos en el administrador</h2></header>
					<div class="table-wrap"><table>
						<thead><tr><th>Contrato</th><th>Estado</th><th>Plan</th><th>Sucursal</th><th class="num">Precio</th></tr></thead>
						<tbody>${contratos.length === 0
							? html`<tr class="empty-row"><td colspan="5" class="muted">Sin contratos importados.</td></tr>`
							: contratos.map(contrato => html`
								<tr><td class="mono">${esc(contrato.idExterno)}</td>
								<td>${pill(contrato.estado.toLowerCase(), estadoContrato(contrato.estado))}</td>
								<td>${esc(contrato.plan)}</td><td>${esc(contrato.sucursal)}</td>
								<td class="num">${usd(contrato.precioCents)}</td></tr>`)}
						</tbody>
					</table></div>
					${contratos.length > 1 ? nota('Un titular con varios contratos vive en un solo cliente: las cuotas de todos se cobran juntas.') : ''}
				</section>
			</div>
			<section class="card"><header><h2>${icon('file-invoice-dollar')}Facturas</h2><span class="muted">Una factura por cuota del administrador</span></header>
				<div class="table-wrap"><table>
					<thead><tr>
						<th>Numero</th><th>Cuota</th><th>Contrato</th><th>Periodo</th><th>Vencimiento</th><th>Corte</th>
						<th class="num">Total</th><th class="num">Saldo</th><th>Estado</th>
					</tr></thead>
					<tbody>${facturas.length === 0
						? html`<tr class="empty-row"><td colspan="9">Sin facturas.</td></tr>`
						: facturas.map(factura => html`
							<tr>
								<td class="mono">${esc(factura.numero)}</td>
								<td class="mono">${esc(factura.idExterno)}</td>
								<td class="mono">${esc(factura.contratoExterno)}</td>
								<td>${date(factura.periodo)}</td>
								<td>${date(factura.vencimiento)}</td>
								<td>${date(factura.corte)}</td>
								<td class="num">${usd(factura.totalCents)}</td>
								<td class="num dinero">${factura.estado === 'PAGADA' ? '—' : usd(factura.saldoCents)}</td>
								<td>${factura.estado === 'PAGADA' ? html`${pill('pagada', 'ok')} <span class="muted">${dateTime(factura.pagadaEn ?? '')}</span>` : pill('abierta', 'warn')}</td>
							</tr>`)}
					</tbody>
				</table></div>
				${totalFacturas > tamano ? controlesPaginacion(`/clientes/${encodeURIComponent(cliente.documento)}`, buscar, paginaFacturas) : ''}
				${nota('El vencimiento es el primer dia del periodo de la cuota, como en el sync real de Cobrix: el administrador de facturas no da un vencimiento por cuota. El corte suma los dias de gracia configurados.')}
			</section>
			${eventos.length > 0 ? html`
			<section class="card"><header><h2>${icon('clock-rotate-left')}Historial</h2></header><div class="body">
				<ul class="timeline">${eventos.map(evento => html`
					<li><time>${dateTime(evento.fecha)}</time>
					<span>${pill(etiquetaEvento(evento.tipo), evento.tipo === 'factura_pagada' ? 'ok' : 'info')}
					${esc(evento.detalle)}</span></li>`)}
				</ul>
				${totalEventos > tamano ? controlesPaginacion(`/clientes/${encodeURIComponent(cliente.documento)}`, buscar, paginaEventos) : ''}
			</div></section>` : ''}`
	}

	function estadoContrato(estado: string): Tone {
		if (estado === 'ACTIVO') return 'ok'
		if (estado === 'CORTADO') return 'warn'
		return 'mute'
	}

	function etiquetaEvento(tipo: string): string {
		if (tipo === 'cliente_creado') return 'cliente creado'
		if (tipo === 'factura_importada') return 'factura importada'
		return 'pagada en el ISP'
	}

	// ---------------------------------------------------------------- Sincronizacion

	function leyendaResultados(): Raw {
		const items: Array<[string, Tone, string]> = [
			['importada', 'ok', 'la cuota entro a Cobrix como factura abierta'],
			['ya importada', 'mute', 'esa cuota ya era una factura: no se duplica'],
			['excluida por estado', 'mute', 'el contrato no esta en los estados configurados'],
			['fuera de ventana', 'info', 'la cuota es mas vieja que la ventana elegida'],
			['frenada por tope', 'info', 'supero el tope de facturas o de monto de la corrida'],
			['marcada pagada', 'ok', 'el ISP la cobro por completo'],
			['abono parcial', 'warn', 'hay algo pagado, pero sigue debiendo'],
			['exonerada', 'mute', 'saldo 0 sin pago: no es un pago'],
			['sin evidencia', 'bad', 'no aparece en el libro: nunca se marca pagada'],
		]
		return html`<div class="leyenda">${items.map(([texto, tono, ayuda]) => html`
			<span class="leyenda-item">${pill(texto, tono)}<span class="muted">${ayuda}</span></span>`)}
		</div>`
	}

	function sincronizacion(buscar: URLSearchParams, flash?: Flash | undefined): Raw {
		const total = almacen.contarCorridas()
		const tamano = Math.max(1, Number(buscar.get('tamano')) || TAMANO_POR_DEFECTO)
		const info = pagina(Number(buscar.get('pagina')) || 1, tamano, total)
		const corridas = almacen.listarCorridas(100, info.numero, info.tamano)

		return html`
			<section class="grid2">
				<section class="card"><header><h2>${icon('file-import')}Importar cuotas</h2></header><div class="body">
					<p>Recorre todos los contratos del administrador y crea una factura abierta por cuota pendiente.
					Aplica los estados, la ventana, el limite de recientes y los topes de la configuracion.</p>
					<div class="acciones">
						<form method="post" action="/acciones/simular-importar">
							<button class="btn" type="submit">${icon('flask')}Simular importacion</button>
						</form>
						<form method="post" action="/acciones/importar" onsubmit="return confirm('Importar clientes y facturas nuevas desde el administrador?')">
							<button class="btn primary" type="submit">${icon('file-import')}Importar</button>
						</form>
					</div>
				</div></section>
				<section class="card"><header><h2>${icon('money-bill-wave')}Actualizar facturas pagadas</h2></header><div class="body">
					<p>Revisa cada factura abierta contra el libro de cuotas y marca pagadas las que el ISP cobro
					por completo: saldo 0, algo pagado y filas coherentes. Los abonos parciales se informan, no se aplican.</p>
					<div class="acciones">
						<form method="post" action="/acciones/simular-pagadas">
							<button class="btn" type="submit">${icon('flask')}Simular actualizacion</button>
						</form>
						<form method="post" action="/acciones/pagadas">
							<button class="btn primary" type="submit">${icon('money-bill-wave')}Actualizar pagadas</button>
						</form>
					</div>
				</div></section>
			</section>
			<section class="card"><header><h2>${icon('clock-rotate-left')}Corridas</h2><span class="muted">${total} en total</span></header>
				<div class="table-wrap"><table>
					<thead><tr><th>#</th><th>Tipo</th><th>Inicio</th><th>Simulacion</th><th>Estado</th><th>Resultado</th><th></th></tr></thead>
					<tbody>${corridas.length === 0
						? html`<tr class="empty-row"><td colspan="7">Todavia no hay corridas. Corre una importacion para empezar.</td></tr>`
						: corridas.map(corrida => html`
							<tr>
								<td class="mono">${corrida.id}</td>
								<td>${corrida.tipo === 'IMPORTACION' ? 'Importacion' : 'Pagadas'}</td>
								<td>${dateTime(corrida.iniciadaEn)}</td>
								<td>${corrida.simulacion ? pill('simulada', 'info') : '—'}</td>
								<td>${corrida.estado === 'FALLIDA' ? pill('fallida', 'bad') : pill('completada', 'ok')}</td>
								<td class="muted">${resumenCorrida(corrida)}${corrida.error ? html` <span class="bad">${esc(corrida.error)}</span>` : ''}</td>
								<td><a class="btn small" href="/sincronizacion/${corrida.id}">${icon('eye')}Detalle</a></td>
							</tr>`)}
					</tbody>
				</table></div>
				${controlesPaginacion('/sincronizacion', buscar, info)}
			</section>`
	}

	function detalleCorrida(id: number, buscar: URLSearchParams, flash?: Flash | undefined): Raw {
		const corrida = almacen.leerCorrida(id)
		if (!corrida) {
			return html`<div class="empty"><h3>${icon('circle-question')}Corrida no encontrada</h3><a href="/sincronizacion">Volver</a></div>`
		}
		const total = almacen.contarItemsCorrida(id)
		const tamano = Math.max(1, Number(buscar.get('tamano')) || TAMANO_POR_DEFECTO)
		const info = pagina(Number(buscar.get('pagina')) || 1, tamano, total)
		const items = almacen.itemsDeCorrida(id, info.numero, info.tamano)
		const r = corrida.resumen
		const esPagadas = corrida.tipo === 'PAGADAS'
		const contadores: Array<{ label: string; icono: string; valor: number; destacado?: boolean; dinero?: boolean }> = esPagadas
			? [
				{ label: 'Facturas consultadas', icono: 'file-invoice-dollar', valor: r.cuotasRevisadas },
				{ label: 'Marcadas pagadas', icono: 'circle-check', valor: r.marcadasPagadas, destacado: true },
				{ label: 'Abonos parciales', icono: 'circle-half-stroke', valor: r.abonosParciales },
				{ label: 'Siguen pendientes', icono: 'clock', valor: r.excluidas },
			]
			: [
				{ label: 'Cuotas revisadas', icono: 'list-check', valor: r.cuotasRevisadas },
				{ label: 'Importadas', icono: 'circle-check', valor: r.importadas, destacado: true },
				{ label: 'Ya importadas', icono: 'copy', valor: r.yaImportadas },
				{ label: 'Clientes nuevos', icono: 'user-plus', valor: r.clientesNuevos },
				{ label: 'Excluidas', icono: 'ban', valor: r.excluidas },
				{ label: 'Frenadas por tope', icono: 'hand', valor: r.frenadas },
				{ label: 'Monto importado', icono: 'sack-dollar', valor: r.montoImportadoCents, destacado: true, dinero: true },
			]

		return html`
			<div class="head"><div><h1>${esPagadas ? 'Actualizacion de pagadas' : 'Importacion'} #${corrida.id} ${corrida.simulacion ? pill('simulada', 'info') : ''}</h1>
				<p><a href="/sincronizacion">${icon('angle-left')} Sincronizacion</a> · ${dateTime(corrida.iniciadaEn)} · ${corrida.estado === 'FALLIDA' ? pill('fallida', 'bad') : pill('completada', 'ok')}</p></div></div>
			${corrida.error ? html`<div class="flash bad">${esc(corrida.error)}</div>` : ''}
			<section class="tiles">${contadores.map(c => html`
				<div class="tile ${c.destacado ? 'featured' : ''}"><span>${icon(c.icono)}${c.label}</span><strong>${c.dinero ? usd(c.valor) : c.valor}</strong></div>`)}
			</section>
			<section class="card">
				<header><h2>${icon('list-check')}Cuota por cuota</h2><span class="muted">${total} filas</span></header>
				<div class="body">${leyendaResultados()}</div>
				<div class="table-wrap"><table>
					<thead><tr>
						<th>Contrato</th><th>Cuota</th><th>Cliente</th>
						<th class="num">Monto</th><th>Resultado</th><th>Motivo</th>
					</tr></thead>
					<tbody>${items.length === 0
						? html`<tr class="empty-row"><td colspan="6">Sin detalle.</td></tr>`
						: items.map(item => html`
							<tr>
								<td class="mono">${esc(item.contratoExterno)}</td>
								<td class="mono">${esc(item.cuotaId)}</td>
								<td>${esc(item.clienteNombre) || '—'}</td>
								<td class="num">${usd(item.montoCents)}</td>
								<td>${pill(etiquetaResultado(item.resultado), tonoResultado(item.resultado))}</td>
								<td class="muted">${esc(item.motivo) || '—'}</td>
							</tr>`)}
					</tbody>
				</table></div>
				${controlesPaginacion(`/sincronizacion/${id}`, buscar, info)}
			</section>`
	}

	function etiquetaResultado(resultado: ResultadoCuota): string {
		if (resultado === 'importada') return 'importada'
		if (resultado === 'ya_importada') return 'ya importada'
		if (resultado === 'marcada_pagada') return 'marcada pagada'
		if (resultado === 'abono_parcial') return 'abono parcial'
		if (resultado === 'exonerada') return 'exonerada'
		if (resultado === 'sin_evidencia') return 'sin evidencia'
		if (resultado === 'pendiente_contrato') return 'pendiente en contrato'
		if (resultado === 'pendiente_libro') return 'sigue pendiente'
		if (resultado === 'frenada_tope') return 'frenada por tope'
		if (resultado === 'limite_recientes') return 'fuera de recientes'
		if (resultado === 'fuera_ventana') return 'fuera de ventana'
		return resultado.replaceAll('_', ' ')
	}

	function tonoResultado(resultado: ResultadoCuota): Tone {
		if (resultado === 'importada' || resultado === 'marcada_pagada') return 'ok'
		if (resultado === 'abono_parcial' || resultado === 'ya_importada' || resultado === 'pendiente_contrato') return 'warn'
		if (resultado === 'sin_evidencia' || resultado === 'contradiccion' || resultado === 'moneda_incoherente') return 'bad'
		if (resultado === 'frenada_tope' || resultado === 'limite_recientes' || resultado === 'fuera_ventana') return 'info'
		return 'mute'
	}

	// ---------------------------------------------------------------- Configuracion

	function configuracion(flash?: Flash | undefined): Raw {
		const empresa = almacen.leerEmpresa()
		const proveedor = almacen.leerProveedor()
		const config = almacen.leerConfig()
		const estados = ['ACTIVO', 'CORTADO', 'CORTESIA', 'RETIRADO', 'RECHAZADO', 'ANULADO']
		const documentos = ['V', 'E', 'J', 'G', 'P']
		const valorVacio = (valor: number | null): string => valor === null ? '' : String(valor)

		return html`
			<form class="card" method="post" action="/configuracion">
				<header><h2>${icon('sliders')}Configuracion</h2>
					<button class="btn primary" type="submit">${icon('floppy-disk')}Guardar</button></header>
				<div class="body">
					${flash ? html`<div class="flash ${flash.tone}">${flash.html ? flash.html.html : esc(flash.text)}</div>` : ''}
					<p class="muted">Datos de la empresa y del administrador de facturas, con las opciones de importacion.</p>
					<section class="card"><header><h2>${icon('building')}Empresa</h2></header><div class="body">
						<div class="grid2">
							<label class="field">Nombre<input type="text" name="nombre" value="${esc(empresa.nombre)}"></label>
							<label class="field">RIF<input type="text" name="rif" value="${esc(empresa.rif)}" placeholder="J-40123456-7"></label>
							<label class="field">Correo de cobranza<input type="text" name="correo" value="${esc(empresa.correoCobranza)}" placeholder="cobranza@empresa.com"></label>
						</div>
					</div></section>
					<section class="card"><header><h2>${icon('server')}Administrador de facturas</h2>
						<button class="btn" type="submit" formaction="/proveedor/probar" formnovalidate>${icon('plug-circle-check')}Probar conexion</button></header>
					<div class="body">
						<div class="grid2">
							<label class="field">URL de la API<input type="text" name="url" value="${esc(proveedor.url)}" placeholder="http://127.0.0.1:4310"></label>
							<label class="field">Usuario o correo<input type="text" name="usuario" value="${esc(proveedor.usuario)}" autocomplete="off"></label>
							<label class="field">Contrasena
								<input type="password" name="password" placeholder="Vacia para conservar la actual" autocomplete="off">
								<small>No se muestra al editar.</small></label>
						</div>
					</div></section>
					<section class="card"><header><h2>${icon('filter')}Reglas de importacion</h2></header><div class="body">
						<fieldset><legend>Estados de contrato que se importan</legend>
							${estados.map(estado => html`
								<label class="check"><input type="checkbox" name="estado_${estado}" ${config.estadosImportables.includes(estado) ? 'checked' : ''}> ${estado}</label>`)}
						</fieldset>
						<div class="grid2 reglas">
							<label class="field">Ventana de importacion
								<select name="ventana">
									<option value="todas" ${config.ventanaMeses === null ? 'selected' : ''}>Sin ventana</option>
									${[3, 6, 9, 12].map(n => html`<option value="${n}" ${config.ventanaMeses === n ? 'selected' : ''}>${n} meses</option>`)}
								</select>
								<small>Solo cuotas desde el mes actual menos N meses.</small></label>
							<label class="field">Max. cuotas recientes por contrato
								<select name="recientes">
									<option value="" ${config.maxCuotasRecientes === null ? 'selected' : ''}>Todas</option>
									${[1, 2, 3, 6, 12, 24, 60].map(n => html`<option value="${n}" ${config.maxCuotasRecientes === n ? 'selected' : ''}>${n}</option>`)}
								</select>
								<small>Vacio = todas (1 a 60). Se conservan las mas nuevas.</small></label>
							<label class="field">Dias de gracia para el corte
								<input type="number" name="diasGracia" min="0" max="60" value="${config.diasGracia}">
								<small>Corte = vencimiento + dias (0 a 60).</small></label>
							<label class="field">Max. facturas nuevas por corrida
								<input type="number" name="maxFacturas" min="1" value="${valorVacio(config.maxFacturasNuevas)}">
								<small>Vacio = sin tope.</small></label>
							<label class="field">Tope de monto nuevo por corrida (USD)
								<input type="number" name="maxMonto" min="0" step="0.01" value="${valorVacio(config.maxMontoNuevoCents === null ? null : config.maxMontoNuevoCents / 100)}">
								<small>Vacio = sin tope. Lo que exceda queda frenado.</small></label>
							<fieldset><legend>Excluir titulares por tipo de documento</legend>
								${documentos.map(doc => html`
									<label class="check"><input type="checkbox" name="excluir_${doc}" ${config.excluirTiposDocumento.includes(doc) ? 'checked' : ''}> ${doc}</label>`)}
							</fieldset>
						</div>
					</div></section>
					<section class="card"><header><h2>${icon('clock')}Corrida automatica</h2></header><div class="body">
						<div class="grid2">
							<label class="check"><input type="checkbox" name="corridaAutomatica" ${config.corridaAutomatica ? 'checked' : ''}> Importar y actualizar pagadas una vez al dia</label>
							<label class="field">Hora (America/Caracas)
								<input type="time" name="hora" value="${esc(config.horaCorrida)}"></label>
						</div>
					</div></section>
				</div>
			</form>`
	}

	// ---------------------------------------------------------------- Rutas

	async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://prueba.local')
		const path = url.pathname.replace(/\/+$/, '') || '/'
		const buscar = url.searchParams
		const hoy = today()

		if (req.method === 'GET') {
			if (path.startsWith('/assets/')) {
				if (servirAsset(res, path)) return
				res.writeHead(404, { 'content-type': 'text/plain' })
				res.end('no encontrado')
				return
			}
			if (path === '/app.css') return sendStatic(res, 200, CSS + PANEL_CSS, 'text/css; charset=utf-8')
			if (path === '/enunciado') {
				let texto = ''
				try {
					texto = readFileSync(deps.assignmentPath, 'utf8')
				} catch {
					texto = 'No se encontro docs/ENUNCIADO.md.'
				}
				return sendHtml(res, 200, cabecera('Enunciado', '', html`<pre class="doc">${texto}</pre>`))
			}
			if (path === '/') return sendHtml(res, 200, cabecera('Resumen', '/', resumen()))
			if (path === '/clientes') return sendHtml(res, 200, cabecera('Clientes', '/clientes', clientes(buscar)))
			if (path === '/sincronizacion') return sendHtml(res, 200, cabecera('Sincronizacion', '/sincronizacion', sincronizacion(buscar)))
			if (path === '/configuracion') return sendHtml(res, 200, cabecera('Configuracion', '/configuracion', configuracion()))
			if (/^\/sincronizacion\/\d+$/.test(path)) {
				const id = Number(path.split('/').pop())
				return sendHtml(res, 200, cabecera('Detalle de corrida', '/sincronizacion', detalleCorrida(id, buscar)))
			}
			if (/^\/clientes\/[^/]+$/.test(path)) {
				const documento = decodeURIComponent(path.split('/').pop() ?? '')
				return sendHtml(res, 200, cabecera('Expediente', '/clientes', expediente(documento, buscar)))
			}
		}

		if (req.method === 'POST') {
			const entrada = await leerCuerpo(req)

			if (path === '/acciones/importar' || path === '/acciones/simular-importar') {
				const simulacion = path === '/acciones/simular-importar'
				const api = apiDe(almacen, deps.simulatorUrl)
				const resultado = await importar({ almacen, api, hoy, simulacion })
				const flash = resultado.estado === 'FALLIDA'
					? flashNueva('bad',
						`La corrida fallo: ${resultado.error}. Revisa el usuario y la contrasena en Configuracion y vuelve a probar.`,
						html`La corrida fallo: ${esc(resultado.error)}. Revisa el usuario y la contrasena en ${enlaceConfig('Configuracion')} y vuelve a probar.`)
					: flashNueva(simulacion ? 'info' : 'ok', mensajeImportacion(resultado))
				return sendHtml(res, 200, cabecera(simulacion ? 'Importacion simulada' : 'Importacion', '/sincronizacion', detalleCorrida(resultado.corridaId, new URLSearchParams()), flash))
			}
			if (path === '/acciones/pagadas' || path === '/acciones/simular-pagadas') {
				const simulacion = path === '/acciones/simular-pagadas'
				const api = apiDe(almacen, deps.simulatorUrl)
				const resultado = await actualizarPagadas({ almacen, api, hoy, simulacion })
				const flash = resultado.estado === 'FALLIDA'
					? flashNueva('bad',
						`La corrida fallo: ${resultado.error}. Confirma que la API del administrador este levantada y que las credenciales de Configuracion sean validas.`,
						html`La corrida fallo: ${esc(resultado.error)}. Confirma que la API del administrador este levantada y que las credenciales de ${enlaceConfig('Configuracion')} sean validas.`)
					: flashNueva(simulacion ? 'info' : 'ok', mensajePagadas(resultado))
				return sendHtml(res, 200, cabecera(simulacion ? 'Pagadas simuladas' : 'Pagadas', '/sincronizacion', detalleCorrida(resultado.corridaId, new URLSearchParams()), flash))
			}
			if (path === '/proveedor/probar') {
				const api = apiDe(almacen, deps.simulatorUrl)
				try {
					const prueba = await api.probarConexion()
					return sendHtml(res, 200, cabecera('Configuracion', '/configuracion', configuracion(flashNueva('ok', `Conexion correcta: el usuario ${prueba.usuario} ve ${prueba.contratos} contratos.`))))
				} catch (error) {
					const motivo = error instanceof Error ? error.message : String(error)
					const consejo = /Contrase/i.test(motivo)
						? 'Revisa el usuario y la contrasena del administrador.'
						: /conexion|network|fetch|solicitud/i.test(motivo)
							? 'Confirma que la URL responda y que la API este levantada.'
							: 'Guarda la URL, el usuario y la contrasena antes de probar la conexion.'
					return sendHtml(res, 200, cabecera('Configuracion', '/configuracion', configuracion(flashNueva('bad', `No se pudo conectar: ${motivo}. ${consejo}`, html`No se pudo conectar: ${esc(motivo)}. ${esc(consejo)}`))))
				}
			}
			if (path === '/configuracion') {
				const empresaLeida = empresaDesdeFormulario(entrada)
				const proveedorLeido = proveedorDesdeFormulario(entrada, almacen.leerProveedor())
				const configLeida = configDesdeFormulario(entrada)
				const errores = [
					...(empresaLeida.ok ? [] : empresaLeida.errores),
					...(proveedorLeido.ok ? [] : proveedorLeido.errores),
					...(configLeida.ok ? [] : configLeida.errores),
				]
				if (errores.length > 0) {
					return sendHtml(res, 200, cabecera('Configuracion', '/configuracion', configuracion(flashNueva('bad', errores.join('; ')))))
				}
				if (empresaLeida.ok) almacen.guardarEmpresa(empresaLeida.valor)
				if (proveedorLeido.ok) almacen.guardarProveedor(proveedorLeido.valor)
				if (configLeida.ok) almacen.guardarConfig(configLeida.valor)
				return sendHtml(res, 200, cabecera('Configuracion', '/configuracion', configuracion(flashNueva('ok', 'Configuracion guardada.'))))
			}
		}

		sendHtml(res, 404, cabecera('No encontrado', '', html`<h1>No encontrado</h1><p><a href="/">Volver</a></p>`))
	}

	return createServer((req, res) => {
		route(req, res).catch((error: unknown) => {
			console.error('[panel]', error)
			if (!res.headersSent) {
				sendHtml(res, 500, cabecera('Error', '', html`<h1>Algo fallo</h1><p class="muted">${esc(error instanceof Error ? error.message : error)}</p>`))
			}
		})
	})

	function sendStatic(res: ServerResponse, status: number, body: string, type: string): void {
		res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) })
		res.end(body)
	}
}

function flashNueva(tone: Tone, text: string, html?: Raw | undefined): Flash {
	return { tone, text, html }
}

const enlaceConfig = (texto: string): Raw => html`<a href="/configuracion">${esc(texto)}</a>`

function mensajeImportacion(resultado: { simulacion: boolean; contadores: { importadas: number; yaImportadas: number; clientesNuevos: number; montoImportadoCents: number } }): string {
	const r = resultado.contadores
	return resultado.simulacion
		? `Simulacion: se importarian ${r.importadas} facturas nuevas para ${r.clientesNuevos} clientes por ${usd(r.montoImportadoCents)}. No se escribio nada.`
		: `Se importaron ${r.importadas} facturas para ${r.clientesNuevos} clientes nuevos por ${usd(r.montoImportadoCents)}. Ya estaban importadas: ${r.yaImportadas}.`
}

function mensajePagadas(resultado: { simulacion: boolean; contadores: { marcadasPagadas: number; abonosParciales: number; excluidas: number } }): string {
	const r = resultado.contadores
	return resultado.simulacion
		? `Simulacion: se marcarian ${r.marcadasPagadas} pagadas, ${r.abonosParciales} abono(s) parcial(es) y ${r.excluidas} quedarian abiertas. No se escribio nada.`
		: `Se marcaron ${r.marcadasPagadas} pagadas y ${r.abonosParciales} abono(s) parcial(es). Quedan abiertas: ${r.excluidas}.`
}

const PANEL_CSS = `
.doc { margin: 0; white-space: pre-wrap; font: 12.5px/1.6 var(--mono); color: var(--fg); }
.datos-contratos { align-items: start; }
.reglas { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
.tile.featured strong { color: var(--primary-strong); }
@media (prefers-color-scheme: dark) { .tile.featured strong { color: var(--primary); } }
.paginacion .info { display: inline-flex; align-items: center; gap: 6px; }
`
