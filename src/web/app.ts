/**
 * Panel de Cobrix para operar la integracion con el administrador de facturas del ISP.
 *
 * Las pantallas: Resumen, Clientes, Expediente del cliente, Sincronizacion y Configuracion.
 * Los writes de las corridas pasan por `src/cobrix/`; este archivo solo los dispone y los
 * muestra. El diseño es propio: misma estructura de menu que el esqueleto, colores y
 * tipografia del sistema, con estados vacios que dicen que hacer.
 */

import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { Almacen } from '../cobrix/almacen.ts'
import { ClienteApi } from '../cobrix/clienteApi.ts'
import { importar } from '../cobrix/importar.ts'
import { actualizarPagadas } from '../cobrix/pagadas.ts'
import { today } from '../shared/dates.ts'
import { configDesdeFormulario, describirConfig, empresaDesdeFormulario, proveedorDesdeFormulario } from '../cobrix/formularios.ts'
import { CSS, dateTime, date, esc, html, layout, pill, usd, type Raw, type Tone } from './layout.ts'

export interface AppDeps {
	/** El administrador de facturas simulado (mismo proceso, pero se habla por HTTP). */
	readonly simulatorUrl: string
	/** Path de docs/ENUNCIADO.md, servido en /enunciado. */
	readonly assignmentPath: string
	/** Base de Cobrix. */
	readonly almacenPath?: string
}

const ALMACEN = new Map<AppDeps, Almacen>()
let almacenGlobal: Almacen | null = null

function almacenDe(deps: AppDeps): Almacen {
	if (!almacenGlobal) {
		almacenGlobal = new Almacen(deps.almacenPath ?? 'data/cobrix.sqlite')
	}
	return almacenGlobal
}

function apiDe(almacen: Almacen, urlBase: string): ClienteApi {
	const proveedor = almacen.leerProveedor()
	return new ClienteApi({ baseUrl: proveedor.url || urlBase, usuario: proveedor.usuario, password: proveedor.password })
}

interface Flash {
	readonly tone: Tone
	readonly text: string
	/** Texto con enlaces ya escapados, para errores accionables. */
	readonly html?: Raw
}

export function createApp(deps: AppDeps): Server {
	const almacen = almacenDe(deps)

	function sendHtml(res: ServerResponse, status: number, body: string): void {
		send(res, status, body, 'text/html; charset=utf-8')
	}

	function send(res: ServerResponse, status: number, body: string, type: string): void {
		res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) })
		res.end(body)
	}

	function leerCuerpo(req: IncomingMessage): Promise<Record<string, string | undefined>> {
		return new Promise((resolver, rechazar) => {
			const trozos: Buffer[] = []
			req.on('data', (trozo: Buffer) => trozos.push(trozo))
			req.on('end', () => {
				const cuerpo = Buffer.concat(trozos).toString('utf8')
				const params = new URLSearchParams(cuerpo)
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

	// ---------------------------------------------------------------- Resumen

	function resumen(flash?: Flash | undefined): Raw {
		const totales = almacen.totales(today())
		const proveedor = almacen.leerProveedor()
		const config = almacen.leerConfig()
		const corridas = almacen.ultimasCorridas()
		const deudores = almacen.clientesConCuotasVencidas(today())

		const tiles = [
			{ label: 'Clientes', valor: String(totales.clientes), href: '/clientes' },
			{ label: 'Contratos', valor: String(totales.contratos), href: '/clientes' },
			{ label: 'Facturas abiertas', valor: String(totales.facturasAbiertas), href: '/clientes' },
			{ label: 'Facturas pagadas', valor: String(totales.facturasPagadas), href: '/clientes' },
			{ label: 'Por cobrar', valor: usd(totales.porCobrarCents), href: '/clientes' },
			{ label: 'Vencidas', valor: String(totales.vencidas), href: '/clientes' },
		]

		const cuerpo = totales.clientes === 0
			? html`
				<section class="tiles">${tiles.map(tile => html`
					<a class="tile" href="${tile.href}"><span>${tile.label}</span><strong>${tile.valor}</strong></a>`)}
				</section>
				<section class="card"><div class="body">
					<div class="empty">
						<h3>Aun no hay clientes importados</h3>
						<p>Conecta el proveedor en <a href="/configuracion">Configuracion</a> (pulsa <em>Probar conexion</em>)
						y despues importa. Puedes empezar por <em>Simular importacion</em> para ver cuantas cuotas entrarian sin escribir nada.</p>
						<div class="acciones">
							<form method="post" action="/acciones/importar" onsubmit="return confirm('Importar clientes y facturas nuevas desde el administrador?')">
								<button class="btn primary" type="submit">Importar</button>
							</form>
							<form method="post" action="/acciones/simular-importar">
								<button class="btn" type="submit">Simular importacion</button>
							</form>
							<form method="post" action="/acciones/pagadas">
								<button class="btn" type="submit">Actualizar pagadas</button>
							</form>
						</div>
					</div>
				</div></section>`
			: html`
				<section class="tiles">${tiles.map(tile => html`
					<a class="tile" href="${tile.href}"><span>${tile.label}</span><strong>${tile.valor}</strong></a>`)}
				</section>`

		return html`
			${cuerpo}
			<section class="card">
				<header><h2>Proveedor</h2><a class="btn small" href="/configuracion">Configurar</a></header>
				<div class="body">
					${proveedor.url
						? html`<dl class="facts">
							<dt>Administrador</dt><dd>${esc(proveedor.url)}</dd>
							<dt>Usuario</dt><dd>${esc(proveedor.usuario)}</dd>
							<dt>Importacion</dt><dd>${esc(describirConfig(config))}</dd>
							${config.corridaAutomatica
								? html`<dt>Corrida automatica</dt><dd>activa a las ${esc(config.horaCorrida)} (America/Caracas)</dd>`
								: html`<dt>Corrida automatica</dt><dd>inactiva</dd>`}
						</dl>`
						: html`<div class="empty"><p>El proveedor no esta configurado.
							<a href="/configuracion">Configuracion</a>.</p></div>`}
				</div>
			</section>
			${deudores.length > 0 ? html`
				<section class="card">
					<header><h2>Cobro pendiente</h2><a class="btn small" href="/clientes">Ver clientes</a></header>
					<div class="table-wrap"><table>
						<thead><tr><th>Cliente</th><th class="num">Vencidas</th><th class="num">Deuda</th></tr></thead>
						<tbody>${deudores.map(deudor => html`
							<tr><td><a href="/clientes/${encodeURIComponent(deudor.documento)}">${esc(deudor.nombre)}</a></td>
							<td class="num">${deudor.vencidas}</td><td class="num">${usd(deudor.deudaCents)}</td></tr>`)}
						</tbody>
					</table></div>
				</section>` : ''}
			<section class="card">
				<header><h2>Ultimas corridas</h2><a class="btn small" href="/sincronizacion">Todas</a></header>
				<div class="table-wrap"><table>
					<thead><tr><th>Tipo</th><th>Fecha</th><th>Simulacion</th><th>Estado</th><th>Resultado</th></tr></thead>
					<tbody>${corridas.length === 0
						? html`<tr><td colspan="5" class="muted">Todavia no hay corridas.</td></tr>`
						: corridas.map(corrida => html`
							<tr>
								<td>${corrida.tipo === 'IMPORTACION' ? 'Importacion' : 'Pagadas'}</td>
								<td>${dateTime(corrida.iniciadaEn)}</td>
								<td>${corrida.simulacion ? pill('Simulada', 'info') : '—'}</td>
								<td>${corrida.estado === 'FALLIDA' ? pill('Fallida', 'bad') : pill('Completada', 'ok')}</td>
								<td class="muted">${resumenCorrida(corrida)}</td>
							</tr>`)}
					</tbody>
				</table></div>
			</section>
			<section class="card"><div class="body">
				<h2 class="acciones">Acciones rapidas</h2>
				<div class="acciones">
					<form method="post" action="/acciones/importar" onsubmit="return confirm('Importar clientes y facturas nuevas desde el administrador?')">
						<button class="btn primary" type="submit">Importar</button>
					</form>
					<form method="post" action="/acciones/pagadas">
						<button class="btn" type="submit">Actualizar pagadas</button>
					</form>
				</div>
			</div></section>`
	}

	function resumenCorrida(corrida: { tipo: string; resumen: { importadas: number; yaImportadas: number; marcadasPagadas: number; abonosParciales: number } }): string {
		if (corrida.tipo === 'IMPORTACION') {
			const r = corrida.resumen
			if (r.importadas === 0 && r.yaImportadas === 0) return 'sin cambios'
			return `${r.importadas} nuevas · ${r.yaImportadas} ya importadas`
		}
		const r = corrida.resumen
		return `${r.marcadasPagadas} pagadas · ${r.abonosParciales} abono parcial`
	}

	// ---------------------------------------------------------------- Clientes

	function clientes(busqueda: string, flash?: Flash | undefined): Raw {
		const lista = almacen.listarClientes(busqueda)
		return html`
			<section class="card"><div class="body">
				<form class="search" method="get" action="/clientes">
					<input type="search" name="q" value="${esc(busqueda)}" placeholder="Buscar por nombre, cedula o RIF" aria-label="Buscar clientes">
					<button class="btn" type="submit">Buscar</button>
					${busqueda ? html`<a class="btn" href="/clientes">Limpiar</a>` : ''}
				</form>
			</div></section>
			<section class="card">
				<header><h2>Clientes</h2><span class="muted">${lista.length} en total</span></header>
				<div class="table-wrap"><table>
					<thead><tr>
						<th>Nombre</th><th>Documento</th><th>Tipo</th>
						<th class="num">Contratos</th><th class="num">Abiertas</th><th class="num">Pagadas</th>
						<th class="num">Deuda</th><th>Vencimiento mas antiguo</th>
					</tr></thead>
					<tbody>${lista.length === 0
						? html`<tr><td colspan="8" class="muted">${busqueda ? 'Ningun cliente coincide con la busqueda.' : 'Aun no hay clientes. Corre una importacion para traerlos.'}</td></tr>`
						: lista.map(cliente => html`
							<tr>
								<td><a href="/clientes/${encodeURIComponent(cliente.documento)}"><strong>${esc(cliente.nombre)}</strong></a></td>
								<td class="mono">${esc(cliente.documento)}</td>
								<td>${cliente.tipo === 'juridica' ? pill('Juridica', 'info') : 'Natural'}</td>
								<td class="num">${cliente.contratos}</td>
								<td class="num">${cliente.abiertas}</td>
								<td class="num">${cliente.pagadas}</td>
								<td class="num">${usd(cliente.deudaCents)}</td>
								<td>${cliente.vencimientoMasAntiguo ? date(cliente.vencimientoMasAntiguo) : '—'}</td>
							</tr>`)}
					</tbody>
				</table></div>
			</section>`
	}

	// ---------------------------------------------------------------- Expediente

	function expediente(documento: string, flash?: Flash | undefined): Raw {
		const cliente = almacen.leerCliente(documento)
		if (!cliente) {
			return html`<div class="empty"><h3>Cliente no encontrado</h3>
				<p>El documento <span class="mono">${esc(documento)}</span> no esta en Cobrix.
				<a href="/clientes">Volver a Clientes</a>.</p></div>`
		}
		const contratos = almacen.contratosDeCliente(cliente.id)
		const facturas = almacen.facturasDeCliente(cliente.id)
		const eventos = almacen.eventosDeCliente(cliente.id)
		const abiertas = facturas.filter(factura => factura.estado === 'ABIERTA')
		const pagadas = facturas.filter(factura => factura.estado === 'PAGADA')
		const deuda = abiertas.reduce((suma, factura) => suma + factura.saldoCents, 0)

		return html`
			<div class="head"><div><h1>${esc(cliente.nombre)}</h1>
				<p><a href="/clientes">Clientes</a> · expediente</p></div></div>
			<section class="tiles">
				<div class="tile"><span>Deuda</span><strong>${usd(deuda)}</strong></div>
				<div class="tile"><span>Facturas abiertas</span><strong>${abiertas.length}</strong></div>
				<div class="tile"><span>Facturas pagadas</span><strong>${pagadas.length}</strong></div>
			</section>
			<section class="card"><header><h2>Datos del cliente</h2></header><div class="body">
				<dl class="facts">
					<dt>Documento</dt><dd class="mono">${esc(cliente.documento)}</dd>
					<dt>Tipo</dt><dd>${cliente.tipo === 'juridica' ? 'Persona juridica' : 'Persona natural'}</dd>
					<dt>Correo</dt><dd>${esc(cliente.email) || '—'}</dd>
					<dt>Telefono</dt><dd>${esc(cliente.telefono) || '—'}</dd>
					<dt>Origen</dt><dd>${esc(cliente.origen)}</dd>
				</dl>
			</div></section>
			<section class="card"><header><h2>Contratos en el administrador</h2></header>
				<div class="table-wrap"><table>
					<thead><tr><th>Contrato</th><th>Estado</th><th>Plan</th><th>Sucursal</th><th class="num">Precio</th></tr></thead>
					<tbody>${contratos.length === 0
						? html`<tr><td colspan="5" class="muted">Sin contratos importados.</td></tr>`
						: contratos.map(contrato => html`
							<tr><td class="mono">${esc(contrato.idExterno)}</td>
							<td>${pill(contrato.estado, estadoContrato(contrato.estado))}</td>
							<td>${esc(contrato.plan)}</td><td>${esc(contrato.sucursal)}</td>
							<td class="num">${usd(contrato.precioCents)}</td></tr>`)}
					</tbody>
				</table></div>
			</section>
			<section class="card"><header><h2>Facturas</h2></header>
				<div class="table-wrap"><table>
					<thead><tr>
						<th>Numero</th><th>Cuota</th><th>Contrato</th><th>Periodo</th><th>Vencimiento</th><th>Corte</th>
						<th class="num">Total</th><th class="num">Saldo</th><th>Estado</th>
					</tr></thead>
					<tbody>${facturas.length === 0
						? html`<tr><td colspan="9" class="muted">Sin facturas.</td></tr>`
						: facturas.map(factura => html`
							<tr>
								<td class="mono">${esc(factura.numero)}</td>
								<td class="mono">${esc(factura.idExterno)}</td>
								<td class="mono">${esc(factura.contratoExterno)}</td>
								<td>${date(factura.periodo)}</td>
								<td>${date(factura.vencimiento)}</td>
								<td>${date(factura.corte)}</td>
								<td class="num">${usd(factura.totalCents)}</td>
								<td class="num">${factura.estado === 'PAGADA' ? '—' : usd(factura.saldoCents)}</td>
								<td>${factura.estado === 'PAGADA' ? html`${pill('Pagada', 'ok')} ${dateTime(factura.pagadaEn ?? '')}` : pill('Abierta', 'warn')}</td>
							</tr>`)}
					</tbody>
				</table></div>
			</section>
			${eventos.length > 0 ? html`
				<section class="card"><header><h2>Historial</h2></header><div class="body">
					<ul class="timeline">${eventos.map(evento => html`
						<li><time>${dateTime(evento.fecha)}</time>
						<span>${pill(etiquetaEvento(evento.tipo), evento.tipo === 'factura_pagada' ? 'ok' : 'info')}
						${esc(evento.detalle)}</span></li>`)}
					</ul>
				</div></section>` : ''}`
	}

	function estadoContrato(estado: string): Tone {
		if (estado === 'ACTIVO') return 'ok'
		if (estado === 'CORTADO') return 'warn'
		return 'mute'
	}

	function etiquetaEvento(tipo: string): string {
		if (tipo === 'cliente_creado') return 'Cliente creado'
		if (tipo === 'factura_importada') return 'Factura importada'
		return 'Factura pagada'
	}

	// ---------------------------------------------------------------- Sincronizacion

	function sincronizacion(flash?: Flash | undefined): Raw {
		const corridas = almacen.listarCorridas(25)
		return html`
			<section class="grid2">
				<section class="card"><header><h2>Importar</h2></header><div class="body">
					<p>Trae clientes y facturas nuevas del administrador. Las cuotas ya importadas no se repiten.</p>
					<div class="acciones">
						<form method="post" action="/acciones/importar" onsubmit="return confirm('Importar clientes y facturas nuevas desde el administrador?')">
							<button class="btn primary" type="submit">Importar</button>
						</form>
						<form method="post" action="/acciones/simular-importar">
							<button class="btn" type="submit">Simular importacion</button>
						</form>
					</div>
				</div></section>
				<section class="card"><header><h2>Actualizar pagadas</h2></header><div class="body">
					<p>Revisa las facturas abiertas contra el libro de pagos y marca las cobradas por completo.</p>
					<div class="acciones">
						<form method="post" action="/acciones/pagadas">
							<button class="btn primary" type="submit">Actualizar pagadas</button>
						</form>
						<form method="post" action="/acciones/simular-pagadas">
							<button class="btn" type="submit">Simular actualizacion</button>
						</form>
					</div>
				</div></section>
			</section>
			<section class="card"><header><h2>Historial de corridas</h2></header>
				<div class="table-wrap"><table>
					<thead><tr><th>#</th><th>Tipo</th><th>Fecha</th><th>Simulacion</th><th>Estado</th><th>Resultado</th><th></th></tr></thead>
					<tbody>${corridas.length === 0
						? html`<tr><td colspan="7" class="muted">Todavia no hay corridas. Corre una importacion para empezar.</td></tr>`
						: corridas.map(corrida => html`
							<tr>
								<td class="mono">${corrida.id}</td>
								<td>${corrida.tipo === 'IMPORTACION' ? 'Importacion' : 'Pagadas'}</td>
								<td>${dateTime(corrida.iniciadaEn)}</td>
								<td>${corrida.simulacion ? pill('Simulada', 'info') : '—'}</td>
								<td>${corrida.estado === 'FALLIDA' ? pill('Fallida', 'bad') : pill('Completada', 'ok')}</td>
								<td class="muted">${resumenCorrida(corrida)}${corrida.error ? html` <span class="bad">${esc(corrida.error)}</span>` : ''}</td>
								<td><a class="btn small" href="/sincronizacion/${corrida.id}">Detalle</a></td>
							</tr>`)}
					</tbody>
				</table></div>
			</section>`
	}

	function detalleCorrida(id: number, flash?: Flash | undefined): Raw {
		const corrida = almacen.leerCorrida(id)
		if (!corrida) {
			return html`<div class="empty"><h3>Corrida no encontrada</h3><a href="/sincronizacion">Volver</a></div>`
		}
		const items = almacen.itemsDeCorrida(id)
		const r = corrida.resumen
		const contadores: Array<{ label: string; valor: number; destacado?: boolean }> = [
			{ label: 'Cuotas revisadas', valor: r.cuotasRevisadas },
			{ label: 'Importadas', valor: r.importadas, destacado: true },
			{ label: 'Ya importadas', valor: r.yaImportadas },
			{ label: 'Marcadas pagadas', valor: r.marcadasPagadas, destacado: true },
			{ label: 'Abonos parciales', valor: r.abonosParciales },
			{ label: 'Excluidas', valor: r.excluidas },
			{ label: 'Frenadas por tope', valor: r.frenadas },
			{ label: 'Clientes nuevos', valor: r.clientesNuevos },
			{ label: 'Monto importado', valor: r.montoImportadoCents, destacado: true },
		]

		return html`
			<div class="head"><div><h1>Corrida ${corrida.id} · ${corrida.tipo === 'IMPORTACION' ? 'Importacion' : 'Pagadas'}</h1>
				<p><a href="/sincronizacion">Sincronizacion</a> · detalle</p></div></div>
			${corrida.error ? html`<div class="flash bad">${esc(corrida.error)}</div>` : ''}
			<section class="tiles">${contadores.map(c => html`
				<div class="tile"><span>${c.label}</span><strong>${c.valor > 0 || c.destacado ? (c.label === 'Monto importado' ? usd(c.valor) : c.valor) : '0'}</strong></div>`)}
			</section>
			<section class="card"><header><h2>Cuota por cuota</h2></header>
				<div class="table-wrap"><table>
					<thead><tr>
						<th>Contrato</th><th>Cuota</th><th>Cliente</th>
						<th class="num">Monto</th><th>Resultado</th><th>Motivo</th>
					</tr></thead>
					<tbody>${items.length === 0
						? html`<tr><td colspan="6" class="muted">Sin detalle.</td></tr>`
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
			</section>`
	}

	function etiquetaResultado(resultado: string): string {
		if (resultado === 'importada') return 'Importada'
		if (resultado === 'ya_importada') return 'Ya importada'
		if (resultado === 'marcada_pagada') return 'Marcada pagada'
		if (resultado === 'abono_parcial') return 'Abono parcial'
		if (resultado === 'exonerada') return 'Exonerada'
		if (resultado === 'sin_evidencia') return 'Sin evidencia'
		if (resultado === 'pendiente_contrato') return 'Pendiente en contrato'
		if (resultado === 'pendiente_libro') return 'Pendiente en libro'
		if (resultado === 'frenada_tope') return 'Frenada por tope'
		if (resultado === 'limite_recientes') return 'Fuera de recientes'
		if (resultado === 'fuera_ventana') return 'Fuera de ventana'
		return resultado.replaceAll('_', ' ')
	}

	function tonoResultado(resultado: string): Tone {
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
				<header><h2>Configuracion</h2><button class="btn primary" type="submit">Guardar</button></header>
				<div class="body">
					${flash ? html`<div class="flash ${flash.tone}">${esc(flash.text)}</div>` : ''}
					<section class="card"><header><h2>Empresa</h2></header><div class="body">
						<div class="grid2">
							<label class="field">Nombre<input type="text" name="nombre" value="${esc(empresa.nombre)}"></label>
							<label class="field">RIF<input type="text" name="rif" value="${esc(empresa.rif)}" placeholder="J-40123456-7"></label>
							<label class="field">Correo de cobranza<input type="text" name="correo" value="${esc(empresa.correoCobranza)}" placeholder="cobranza@empresa.com"></label>
						</div>
					</div></section>
					<section class="card"><header><h2>Proveedor</h2></header><div class="body">
						<div class="grid2">
							<label class="field">URL de la API<input type="text" name="url" value="${esc(proveedor.url)}" placeholder="https://isp.example.com/api"></label>
							<label class="field">Usuario<input type="text" name="usuario" value="${esc(proveedor.usuario)}" autocomplete="off"></label>
							<label class="field">Contrasena
								<input type="password" name="password" placeholder="Vacia para conservar la actual" autocomplete="off"></label>
						</div>
						<div class="acciones">
							<button class="btn" type="submit" formaction="/proveedor/probar" formnovalidate>Probar conexion</button>
						</div>
					</div></section>
					<section class="card"><header><h2>Reglas de importacion</h2></header><div class="body">
						<div class="grid2">
							<fieldset><legend>Estados que se importan</legend>
								${estados.map(estado => html`
									<label><input type="checkbox" name="estado_${estado}" ${config.estadosImportables.includes(estado) ? 'checked' : ''}> ${estado}</label>`)}
							</fieldset>
							<div class="grid2">
								<label class="field">Ventana de importacion
									<select name="ventana">
										<option value="todas" ${config.ventanaMeses === null ? 'selected' : ''}>Sin ventana</option>
										${[3, 6, 9, 12].map(n => html`<option value="${n}" ${config.ventanaMeses === n ? 'selected' : ''}>${n} meses</option>`)}
									</select></label>
								<label class="field">Cuotas recientes por contrato
									<select name="recientes">
										<option value="" ${config.maxCuotasRecientes === null ? 'selected' : ''}>Todas</option>
										${[1, 2, 3, 6, 12, 24, 60].map(n => html`<option value="${n}" ${config.maxCuotasRecientes === n ? 'selected' : ''}>${n}</option>`)}
									</select></label>
								<label class="field">Dias de gracia para el corte
									<input type="number" name="diasGracia" min="0" max="60" value="${config.diasGracia}"></label>
								<label class="field">Max facturas nuevas por corrida
									<input type="number" name="maxFacturas" min="1" value="${valorVacio(config.maxFacturasNuevas)}"></label>
								<label class="field">Max monto nuevo por corrida (USD)
									<input type="number" name="maxMonto" min="0" step="0.01" value="${valorVacio(config.maxMontoNuevoCents === null ? null : config.maxMontoNuevoCents / 100)}"></label>
								<fieldset><legend>Excluir titulares por documento</legend>
									${documentos.map(doc => html`
										<label><input type="checkbox" name="excluir_${doc}" ${config.excluirTiposDocumento.includes(doc) ? 'checked' : ''}> ${doc}</label>`)}
								</fieldset>
							</div>
						</div>
					</div></section>
					<section class="card"><header><h2>Corrida automatica</h2></header><div class="body">
						<div class="grid2">
							<label><input type="checkbox" name="corridaAutomatica" ${config.corridaAutomatica ? 'checked' : ''}> Activar corrida diaria</label>
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
		const query = url.searchParams
		const flash = (tone: Tone, text: string): Flash => ({ tone, text })

		if (req.method === 'GET') {
			if (path === '/app.css') return send(res, 200, CSS + PANEL_CSS, 'text/css; charset=utf-8')
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
			if (path === '/clientes') return sendHtml(res, 200, cabecera('Clientes', '/clientes', clientes(query.get('q') ?? '')))
			if (path === '/sincronizacion') return sendHtml(res, 200, cabecera('Sincronizacion', '/sincronizacion', sincronizacion()))
			if (path === '/configuracion') return sendHtml(res, 200, cabecera('Configuracion', '/configuracion', configuracion()))
			if (/^\/sincronizacion\/\d+$/.test(path)) {
				const id = Number(path.split('/').pop())
				return sendHtml(res, 200, cabecera('Corrida', '/sincronizacion', detalleCorrida(id)))
			}
			if (/^\/clientes\/[^/]+$/.test(path)) {
				const documento = decodeURIComponent(path.split('/').pop() ?? '')
				return sendHtml(res, 200, cabecera('Expediente', '/clientes', expediente(documento)))
			}
		}

		if (req.method === 'POST') {
			const entrada = await leerCuerpo(req)
			const hoy = today()

			if (path === '/acciones/importar' || path === '/acciones/simular-importar') {
				const simulacion = path === '/acciones/simular-importar'
				const api = apiDe(almacen, deps.simulatorUrl)
				const resultado = await importar({ almacen, api, hoy, simulacion })
				const flash = resultado.estado === 'FALLIDA'
					? flashNueva('bad',
						`La corrida fallo: ${resultado.error}. Revisa el usuario y la contrasena en Configuracion y vuelve a probar.`,
						html`La corrida fallo: ${esc(resultado.error)}. Revisa el usuario y la contrasena en ${enlaceConfig('Configuracion')} y vuelve a probar.`)
					: flashNueva(simulacion ? 'info' : 'ok', mensajeImportacion(resultado))
				return sendHtml(res, 200, cabecera(simulacion ? 'Importacion simulada' : 'Importacion', '/sincronizacion', detalleCorrida(resultado.corridaId), flash))
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
				return sendHtml(res, 200, cabecera(simulacion ? 'Pagadas simuladas' : 'Pagadas', '/sincronizacion', detalleCorrida(resultado.corridaId), flash))
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
					const htmlMotivo = html`No se pudo conectar: ${esc(motivo)}. ${esc(consejo)}`
					return sendHtml(res, 200, cabecera('Configuracion', '/configuracion', configuracion(flashNueva('bad', `No se pudo conectar: ${motivo}. ${consejo}`, htmlMotivo))))
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
}

function flashNueva(tone: Tone, text: string, html?: Raw | undefined): Flash {
	return { tone, text, html }
}

/** Enlace accionable dentro de un flash de error. */
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
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px 18px; }
.search { display: flex; gap: 8px; max-width: 420px; }
.acciones { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.empty { border: 1px dashed var(--line); border-radius: 8px; padding: 14px 16px; color: var(--muted); }
.empty h3 { margin: 0 0 4px; color: var(--fg); font-size: 14px; }
.empty p { margin: 0; }
form.card .body section.card { background: var(--sunken); }
fieldset { border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; margin: 0; display: flex; flex-wrap: wrap; gap: 6px 16px; }
fieldset legend { font-weight: 600; font-size: 13px; padding: 0 4px; }
fieldset label { display: inline-flex; gap: 6px; align-items: center; font-size: 13.5px; }
label.field { display: grid; gap: 5px; font-weight: 600; font-size: 13px; }
label.field small { font-weight: 400; color: var(--muted); }
label:has(> input[type=checkbox]) { display: inline-flex; gap: 6px; align-items: center; font-weight: 400; }
input[type=text], input[type=password], input[type=number], input[type=search], input[type=time], input[type=url], select {
	font: 14px var(--font); padding: 7px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); color: var(--fg); width: 100%; }
input[type=checkbox] { width: auto; }
dl.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 16px; margin: 0; }
dl.facts dt { color: var(--muted); }
dl.facts dd { margin: 0; }
.timeline { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.timeline li { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 10px; align-items: baseline; }
.timeline time { color: var(--muted); font-size: 12.5px; }
.tile { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; display: grid; gap: 2px; }
.tile span { color: var(--muted); font-size: 12px; }
.tile strong { font-size: 20px; font-variant-numeric: tabular-nums; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
a.tile { text-decoration: none; color: inherit; }
a.tile:hover { border-color: var(--primary); }
table .bad { color: var(--bad); }
@media (max-width: 860px) {
	.shell { grid-template-columns: minmax(0, 1fr); }
	.side { position: static; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center; }
	.side nav { display: flex; flex-wrap: wrap; }
	.side-foot { display: none; }
	.main { padding: 16px; }
	.timeline li { grid-template-columns: minmax(0, 1fr); gap: 2px; }
}
`
