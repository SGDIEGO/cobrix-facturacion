/**
 * Almacen de Cobrix en `node:sqlite`: empresa, proveedor, configuracion, clientes,
 * contratos, facturas, corridas con su detalle por cuota e historial.
 *
 * Esta base es propia: nunca se lee `data/billing-api.sqlite` (esa es del administrador).
 * Los montos se guardan en centavos de USD para no arrastrar errores de punto flotante.
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import type {
	ClienteDetalle,
	ClienteResumen,
	Config,
	Contadores,
	ContratoDetalle,
	Corrida,
	CorridaItem,
	Empresa,
	Evento,
	FacturaDetalle,
	Proveedor,
	ResultadoCuota,
	TipoCorrida,
	Totales,
} from './tipos.ts'
import { CONFIG_POR_DEFECTO } from './tipos.ts'

interface FilaEmpresa { nombre: string; rif: string; correo_cobranza: string }
interface FilaProveedor { url: string; usuario: string; password: string }
interface FilaCliente extends Record<string, unknown> {
	id: number; documento: string; nombre: string; tipo: string; email: string; telefono: string; origen: string
}
interface FilaFactura extends Record<string, unknown> {
	id: number; numero: string; id_externo: string; cliente_id: number; cliente_documento: string; cliente_nombre: string
	contrato_externo: string; periodo: string
	vencimiento: string; corte: string; total_cents: number; saldo_cents: number; estado: string
	pagada_en: string | null; pago_facturas_isp: string
}
interface FilaContadores extends Record<string, unknown> {
	cuotas: number; abiertas: number; pagadas: number; deuda: number | null; vencidas: number | null
}
interface FilaCorrida extends Record<string, unknown> {
	id: number; tipo: string; simulacion: number; estado: string; iniciada_en: string
	terminada_en: string | null; resumen: string; error: string
}
interface FilaItem extends Record<string, unknown> {
	id: number; contrato_externo: string; cuota_id: string; cliente_documento: string; cliente_nombre: string
	resultado: string; motivo: string; monto_cents: number; detalle: string
}

const ESQUEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS empresa (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	nombre TEXT NOT NULL DEFAULT '', rif TEXT NOT NULL DEFAULT '', correo_cobranza TEXT NOT NULL DEFAULT '',
	actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO empresa (id) VALUES (1);
CREATE TABLE IF NOT EXISTS proveedor (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	url TEXT NOT NULL DEFAULT '', usuario TEXT NOT NULL DEFAULT '', password TEXT NOT NULL DEFAULT '',
	actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO proveedor (id) VALUES (1);
CREATE TABLE IF NOT EXISTS config (
	id INTEGER PRIMARY KEY CHECK (id = 1), datos TEXT NOT NULL DEFAULT '{}'
);
INSERT OR IGNORE INTO config (id, datos) VALUES (1, '{}');
CREATE TABLE IF NOT EXISTS cliente (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	documento TEXT NOT NULL UNIQUE,
	nombre TEXT NOT NULL DEFAULT '',
	tipo TEXT NOT NULL DEFAULT 'natural',
	email TEXT NOT NULL DEFAULT '', telefono TEXT NOT NULL DEFAULT '',
	origen TEXT NOT NULL DEFAULT 'Administrador de facturas',
	creado_en TEXT NOT NULL DEFAULT (datetime('now')),
	actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contrato (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	id_externo TEXT NOT NULL UNIQUE,
	cliente_id INTEGER NOT NULL REFERENCES cliente(id),
	estado TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT '', precio_cents INTEGER NOT NULL DEFAULT 0,
	sucursal TEXT NOT NULL DEFAULT '', moneda TEXT NOT NULL DEFAULT 'USD',
	actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS factura (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	numero TEXT NOT NULL UNIQUE,
	id_externo TEXT NOT NULL UNIQUE,
	cliente_id INTEGER NOT NULL REFERENCES cliente(id),
	contrato_externo TEXT NOT NULL DEFAULT '',
	periodo TEXT NOT NULL, vencimiento TEXT NOT NULL, corte TEXT NOT NULL,
	total_cents INTEGER NOT NULL DEFAULT 0, saldo_cents INTEGER NOT NULL DEFAULT 0,
	estado TEXT NOT NULL DEFAULT 'ABIERTA',
	pagada_en TEXT, pago_facturas_isp TEXT NOT NULL DEFAULT '',
	creado_en TEXT NOT NULL DEFAULT (datetime('now')),
	actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS factura_cliente ON factura(cliente_id, estado);
CREATE INDEX IF NOT EXISTS factura_estado ON factura(estado, vencimiento);
CREATE TABLE IF NOT EXISTS corrida (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	tipo TEXT NOT NULL, simulacion INTEGER NOT NULL DEFAULT 0, estado TEXT NOT NULL,
	iniciada_en TEXT NOT NULL DEFAULT (datetime('now')), terminada_en TEXT,
	resumen TEXT NOT NULL DEFAULT '{}', error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS corrida_item (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	corrida_id INTEGER NOT NULL REFERENCES corrida(id),
	contrato_externo TEXT NOT NULL DEFAULT '', cuota_id TEXT NOT NULL DEFAULT '',
	cliente_documento TEXT NOT NULL DEFAULT '', cliente_nombre TEXT NOT NULL DEFAULT '',
	resultado TEXT NOT NULL, motivo TEXT NOT NULL DEFAULT '', monto_cents INTEGER NOT NULL DEFAULT 0,
	detalle TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS corrida_item_corrida ON corrida_item(corrida_id);
CREATE TABLE IF NOT EXISTS evento (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	cliente_id INTEGER NOT NULL REFERENCES cliente(id), factura_id INTEGER REFERENCES factura(id),
	tipo TEXT NOT NULL, fecha TEXT NOT NULL DEFAULT (datetime('now')), detalle TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS evento_cliente ON evento(cliente_id, id DESC);
`

export const ALMACEN_POR_DEFECTO = resolve('data/cobrix.sqlite')

export class Almacen {
	private readonly db: DatabaseSync

	constructor(ruta: string = ALMACEN_POR_DEFECTO) {
		mkdirSync(dirname(ruta), { recursive: true })
		this.db = new DatabaseSync(ruta)
		this.db.exec(ESQUEMA)
	}

	cerrar(): void {
		this.db.close()
	}

	// ------------------------------------------------------------ empresa y proveedor

	leerEmpresa(): Empresa {
		const fila = this.db.prepare('SELECT nombre, rif, correo_cobranza FROM empresa WHERE id = 1').get() as unknown as FilaEmpresa
		return { nombre: fila.nombre, rif: fila.rif, correoCobranza: fila.correo_cobranza }
	}

	guardarEmpresa(empresa: Empresa): void {
		this.db.prepare('UPDATE empresa SET nombre = ?, rif = ?, correo_cobranza = ?, actualizado_en = datetime(\'now\') WHERE id = 1')
			.run(empresa.nombre, empresa.rif, empresa.correoCobranza)
	}

	leerProveedor(): Proveedor {
		const fila = this.db.prepare('SELECT url, usuario, password FROM proveedor WHERE id = 1').get() as unknown as FilaProveedor
		return { url: fila.url, usuario: fila.usuario, password: fila.password }
	}

	guardarProveedor(proveedor: Proveedor): void {
		this.db.prepare('UPDATE proveedor SET url = ?, usuario = ?, password = ?, actualizado_en = datetime(\'now\') WHERE id = 1')
			.run(proveedor.url, proveedor.usuario, proveedor.password)
	}

	hayProveedor(): boolean {
		const fila = this.db.prepare('SELECT COUNT(*) AS n FROM proveedor WHERE id = 1 AND url <> \'\' AND usuario <> \'\' AND password <> \'\'').get() as unknown as Record<string, unknown>
		return Number(fila.n) > 0
	}

	// ------------------------------------------------------------ configuracion

	leerConfig(): Config {
		const fila = this.db.prepare('SELECT datos FROM config WHERE id = 1').get() as unknown as Record<string, unknown>
		return fusionarConfig(fila.datos)
	}

	guardarConfig(config: Config): void {
		this.db.prepare('UPDATE config SET datos = ? WHERE id = 1').run(JSON.stringify(config))
	}

	// ------------------------------------------------------------ corridas

	abrirCorrida(tipo: TipoCorrida, simulacion: boolean): number {
		const resultado = this.db.prepare('INSERT INTO corrida (tipo, simulacion, estado) VALUES (?, ?, ?)').run(tipo, simulacion ? 1 : 0, 'COMPLETADA')
		return Number(resultado.lastInsertRowid)
	}

	cerrarCorrida(id: number, estado: 'COMPLETADA' | 'FALLIDA', contadores: Contadores, error = ''): void {
		this.db.prepare('UPDATE corrida SET estado = ?, terminada_en = datetime(\'now\'), resumen = ?, error = ? WHERE id = ?')
			.run(estado, JSON.stringify(contadores), error, id)
	}

	registrarItem(corridaId: number, item: {
		contratoExterno: string; cuotaId: string; clienteDocumento: string; clienteNombre: string
		resultado: ResultadoCuota; motivo: string; montoCents: number; detalle: string
	}): void {
		this.db.prepare(`INSERT INTO corrida_item
			(corrida_id, contrato_externo, cuota_id, cliente_documento, cliente_nombre, resultado, motivo, monto_cents, detalle)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(corridaId, item.contratoExterno, item.cuotaId, item.clienteDocumento, item.clienteNombre,
				item.resultado, item.motivo, item.montoCents, item.detalle)
	}

	listarCorridas(limite = 30): Corrida[] {
		const filas = this.db.prepare('SELECT * FROM corrida ORDER BY id DESC LIMIT ?').all(limite) as unknown as FilaCorrida[]
		return filas.map(fila => ({
			id: fila.id, tipo: fila.tipo as TipoCorrida, simulacion: fila.simulacion === 1,
			estado: fila.estado === 'FALLIDA' ? 'FALLIDA' : 'COMPLETADA',
			iniciadaEn: fila.iniciada_en, terminadaEn: fila.terminada_en,
			resumen: leerContadores(fila.resumen), error: fila.error,
		}))
	}

	leerCorrida(id: number): Corrida | null {
		const fila = this.db.prepare('SELECT * FROM corrida WHERE id = ?').get(id) as FilaCorrida | undefined
		if (!fila) return null
		return {
			id: fila.id, tipo: fila.tipo as TipoCorrida, simulacion: fila.simulacion === 1,
			estado: fila.estado === 'FALLIDA' ? 'FALLIDA' : 'COMPLETADA',
			iniciadaEn: fila.iniciada_en, terminadaEn: fila.terminada_en,
			resumen: leerContadores(fila.resumen), error: fila.error,
		}
	}

	itemsDeCorrida(id: number): CorridaItem[] {
		const filas = this.db.prepare('SELECT * FROM corrida_item WHERE corrida_id = ? ORDER BY id').all(id) as unknown as FilaItem[]
		return filas.map(fila => ({
			id: fila.id, contratoExterno: fila.contrato_externo, cuotaId: fila.cuota_id,
			clienteDocumento: fila.cliente_documento, clienteNombre: fila.cliente_nombre,
			resultado: fila.resultado as ResultadoCuota, motivo: fila.motivo,
			montoCents: fila.monto_cents, detalle: fila.detalle,
		}))
	}

	ultimasCorridas(): { id: number; tipo: TipoCorrida; estado: string; simulacion: boolean; iniciadaEn: string; resumen: Contadores; error: string }[] {
		return this.listarCorridas(6).map(corrida => ({
			id: corrida.id, tipo: corrida.tipo, estado: corrida.estado, simulacion: corrida.simulacion,
			iniciadaEn: corrida.iniciadaEn, resumen: corrida.resumen, error: corrida.error,
		}))
	}

	// ------------------------------------------------------------ clientes y facturas

	buscarCliente(documento: string): FilaCliente | null {
		return (this.db.prepare('SELECT * FROM cliente WHERE documento = ?').get(documento) as FilaCliente | undefined) ?? null
	}

	crearCliente(datos: { documento: string; nombre: string; tipo: string; email: string; telefono: string }): number {
		const resultado = this.db.prepare(
			'INSERT INTO cliente (documento, nombre, tipo, email, telefono) VALUES (?, ?, ?, ?, ?)',
		).run(datos.documento, datos.nombre, datos.tipo, datos.email, datos.telefono)
		return Number(resultado.lastInsertRowid)
	}

	actualizarCliente(id: number, datos: { nombre: string; email: string; telefono: string }): void {
		this.db.prepare('UPDATE cliente SET nombre = ?, email = ?, telefono = ?, actualizado_en = datetime(\'now\') WHERE id = ?')
			.run(datos.nombre, datos.email, datos.telefono, id)
	}

	guardarContrato(datos: {
		idExterno: string; clienteId: number; estado: string; plan: string; precioCents: number; sucursal: string; moneda: string
	}): void {
		this.db.prepare(`INSERT INTO contrato (id_externo, cliente_id, estado, plan, precio_cents, sucursal, moneda)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id_externo) DO UPDATE SET estado = excluded.estado, plan = excluded.plan,
				precio_cents = excluded.precio_cents, sucursal = excluded.sucursal, moneda = excluded.moneda,
				actualizado_en = datetime('now')`)
			.run(datos.idExterno, datos.clienteId, datos.estado, datos.plan, datos.precioCents, datos.sucursal, datos.moneda)
	}

	facturaPorExterno(idExterno: string): { id: number; saldo_cents: number; estado: string } | null {
		return (this.db.prepare('SELECT id, saldo_cents, estado FROM factura WHERE id_externo = ?').get(idExterno) as { id: number; saldo_cents: number; estado: string } | undefined) ?? null
	}

	crearFactura(datos: {
		numero: string; idExterno: string; clienteId: number; contratoExterno: string; periodo: string
		vencimiento: string; corte: string; totalCents: number
	}): number {
		const resultado = this.db.prepare(`INSERT INTO factura
			(numero, id_externo, cliente_id, contrato_externo, periodo, vencimiento, corte, total_cents, saldo_cents, estado)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ABIERTA')`)
			.run(datos.numero, datos.idExterno, datos.clienteId, datos.contratoExterno, datos.periodo,
				datos.vencimiento, datos.corte, datos.totalCents, datos.totalCents)
		return Number(resultado.lastInsertRowid)
	}

	siguienteNumeroFactura(): string {
		const fila = this.db.prepare('SELECT COUNT(*) AS n FROM factura').get() as unknown as Record<string, unknown>
		return `COB-${String(Number(fila.n) + 1).padStart(6, '0')}`
	}

	facturasAbiertas(): FilaFactura[] {
		return this.db.prepare(`SELECT f.*, c.documento AS cliente_documento, c.nombre AS cliente_nombre
			FROM factura f JOIN cliente c ON c.id = f.cliente_id
			WHERE f.estado = 'ABIERTA' ORDER BY f.vencimiento, f.id`).all() as unknown as FilaFactura[]
	}

	marcarPagada(facturaId: number, facturasIsp: string): void {
		this.db.prepare(`UPDATE factura SET estado = 'PAGADA', saldo_cents = 0, pagada_en = datetime('now'),
			pago_facturas_isp = ?, actualizado_en = datetime('now') WHERE id = ? AND estado = 'ABIERTA'`)
			.run(facturasIsp, facturaId)
	}

	registrarEvento(datos: { clienteId: number; facturaId?: number | undefined; tipo: string; detalle: string }): void {
		this.db.prepare('INSERT INTO evento (cliente_id, factura_id, tipo, detalle) VALUES (?, ?, ?, ?)')
			.run(datos.clienteId, datos.facturaId ?? null, datos.tipo, datos.detalle)
	}

	// ------------------------------------------------------------ consultas del panel

	totales(hoy: string): Totales {
		const fila = this.db.prepare(`SELECT
			(SELECT COUNT(*) FROM cliente) AS clientes,
			(SELECT COUNT(*) FROM contrato) AS contratos,
			(SELECT COUNT(*) FROM factura WHERE estado = 'ABIERTA') AS abiertas,
			(SELECT COUNT(*) FROM factura WHERE estado = 'PAGADA') AS pagadas,
			(SELECT COALESCE(SUM(saldo_cents), 0) FROM factura WHERE estado = 'ABIERTA') AS por_cobrar,
			(SELECT COUNT(*) FROM factura WHERE estado = 'ABIERTA' AND vencimiento < ?) AS vencidas,
			(SELECT COUNT(*) FROM factura WHERE estado = 'ABIERTA' AND vencimiento >= ? AND corte >= ?) AS por_vencer
		`).get(hoy, hoy, hoy) as unknown as Record<string, number>
		const numero = (clave: string): number => Number(fila[clave] ?? 0)
		return {
			clientes: numero('clientes'), contratos: numero('contratos'), facturasAbiertas: numero('abiertas'),
			facturasPagadas: numero('pagadas'), porCobrarCents: numero('por_cobrar'), vencidas: numero('vencidas'), porVencer: numero('por_vencer'),
		}
	}

	listarClientes(busqueda = ''): ClienteResumen[] {
		const filtro = busqueda.trim() ? '%' + busqueda.trim() + '%' : null
		const filas = this.db.prepare(`SELECT c.id, c.documento, c.nombre, c.tipo,
			(SELECT COUNT(*) FROM contrato k WHERE k.cliente_id = c.id) AS contratos,
			(SELECT COUNT(*) FROM factura f WHERE f.cliente_id = c.id AND f.estado = 'ABIERTA') AS abiertas,
			(SELECT COUNT(*) FROM factura f WHERE f.cliente_id = c.id AND f.estado = 'PAGADA') AS pagadas,
			(SELECT COALESCE(SUM(f.saldo_cents), 0) FROM factura f WHERE f.cliente_id = c.id AND f.estado = 'ABIERTA') AS deuda,
			(SELECT MIN(f.vencimiento) FROM factura f WHERE f.cliente_id = c.id AND f.estado = 'ABIERTA') AS mas_antiguo
			FROM cliente c ${filtro ? 'WHERE c.nombre LIKE ? OR c.documento LIKE ?' : ''} ORDER BY c.nombre`)
			.all(...(filtro ? [filtro, filtro] : [])) as unknown as Array<Record<string, unknown>>
		return filas.map(fila => ({
			id: fila.id as number, documento: String(fila.documento), nombre: String(fila.nombre),
			tipo: (fila.tipo === 'juridica' ? 'juridica' : 'natural') as ClienteResumen['tipo'],
			contratos: Number(fila.contratos), abiertas: Number(fila.abiertas), pagadas: Number(fila.pagadas),
			deudaCents: Number(fila.deuda), vencimientoMasAntiguo: (fila.mas_antiguo as string | null) ?? null,
		}))
	}

	leerCliente(documento: string): ClienteDetalle | null {
		const fila = this.db.prepare('SELECT * FROM cliente WHERE documento = ?').get(documento) as FilaCliente | undefined
		if (!fila) return null
		return {
			id: fila.id, documento: fila.documento, nombre: fila.nombre,
			tipo: fila.tipo === 'juridica' ? 'juridica' : 'natural',
			email: fila.email, telefono: fila.telefono, origen: fila.origen,
		}
	}

	contratosDeCliente(clienteId: number): ContratoDetalle[] {
		const filas = this.db.prepare('SELECT * FROM contrato WHERE cliente_id = ? ORDER BY id_externo').all(clienteId) as unknown as Array<Record<string, unknown>>
		return filas.map(fila => ({
			idExterno: String(fila.id_externo), estado: String(fila.estado), plan: String(fila.plan),
			precioCents: Number(fila.precio_cents), sucursal: String(fila.sucursal), moneda: String(fila.moneda),
		}))
	}

	facturasDeCliente(clienteId: number): FacturaDetalle[] {
		const filas = this.db.prepare('SELECT * FROM factura WHERE cliente_id = ? ORDER BY periodo DESC, id DESC').all(clienteId) as unknown as FilaFactura[]
		return filas.map(fila => ({
			id: fila.id, numero: fila.numero, idExterno: fila.id_externo, contratoExterno: fila.contrato_externo,
			periodo: fila.periodo, vencimiento: fila.vencimiento, corte: fila.corte,
			totalCents: fila.total_cents, saldoCents: fila.saldo_cents,
			estado: fila.estado === 'PAGADA' ? 'PAGADA' : 'ABIERTA',
			pagadaEn: fila.pagada_en, pagoFacturasIsp: fila.pago_facturas_isp,
		}))
	}

	eventosDeCliente(clienteId: number): Evento[] {
		const filas = this.db.prepare('SELECT * FROM evento WHERE cliente_id = ? ORDER BY id DESC').all(clienteId) as unknown as Array<Record<string, unknown>>
		return filas.map(fila => ({
			id: fila.id as number, tipo: fila.tipo as Evento['tipo'], fecha: String(fila.fecha),
			detalle: String(fila.detalle),
		}))
	}

	clientesConCuotasVencidas(hoy: string): { documento: string; nombre: string; deudaCents: number; vencidas: number }[] {
		const filas = this.db.prepare(`SELECT c.documento, c.nombre,
			COALESCE(SUM(f.saldo_cents), 0) AS deuda, COUNT(*) AS vencidas
			FROM factura f JOIN cliente c ON c.id = f.cliente_id
			WHERE f.estado = 'ABIERTA' AND f.vencimiento < ?
			GROUP BY c.id HAVING vencidas > 0 ORDER BY deuda DESC LIMIT 8`).all(hoy) as unknown as Array<Record<string, unknown>>
		return filas.map(fila => ({
			documento: String(fila.documento), nombre: String(fila.nombre),
			deudaCents: Number(fila.deuda), vencidas: Number(fila.vencidas),
		}))
	}
}

/** La configuracion guardada se fusiona con los defaults: si falta un campo, manda el default. */
export function fusionarConfig(datos: unknown): Config {
	const guardada = (datos && typeof datos === 'object' ? datos : {}) as Record<string, unknown>
	const numero = (clave: keyof Config, min: number, max: number): number | null => {
		const valor = guardada[clave]
		if (valor === null || valor === undefined || valor === '') return null
		const n = Number(valor)
		if (!Number.isFinite(n)) return null
		return Math.min(max, Math.max(min, Math.trunc(n)))
	}
	const lista = (clave: keyof Config, permitidas: readonly string[]): string[] => {
		const valor = guardada[clave]
		if (!Array.isArray(valor)) return []
		return valor.filter((item): item is string => typeof item === 'string' && permitidas.includes(item.toUpperCase()))
			.map(item => item.toUpperCase())
	}
	const estados = lista('estadosImportables', ['ACTIVO', 'CORTADO', 'CORTESIA', 'RETIRADO', 'RECHAZADO', 'ANULADO'])
	return {
		estadosImportables: estados.length > 0 ? estados : CONFIG_POR_DEFECTO.estadosImportables,
		ventanaMeses: (() => {
			const valor = guardada.ventanaMeses
			if (valor === null || valor === undefined || valor === '' || valor === 'todas') return null
			const n = Number(valor)
			return [3, 6, 9, 12].includes(n) ? n : null
		})(),
		maxCuotasRecientes: numero('maxCuotasRecientes', 1, 60),
		diasGracia: numero('diasGracia', 0, 60) ?? 0,
		maxFacturasNuevas: numero('maxFacturasNuevas', 1, 100_000),
		maxMontoNuevoCents: (() => {
			const valor = guardada.maxMontoNuevoCents
			if (valor === null || valor === undefined || valor === '') return null
			const n = Number(valor)
			return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null
		})(),
		excluirTiposDocumento: lista('excluirTiposDocumento', ['V', 'E', 'J', 'G', 'P']),
		corridaAutomatica: guardada.corridaAutomatica === true || guardada.corridaAutomatica === 'true',
		horaCorrida: typeof guardada.horaCorrida === 'string' && /^\d{2}:\d{2}$/.test(guardada.horaCorrida)
			? guardada.horaCorrida
			: CONFIG_POR_DEFECTO.horaCorrida,
	}
}

function leerContadores(datos: string): Contadores {
	try {
		const valor = JSON.parse(datos || '{}') as Record<string, unknown>
		return {
			cuotasRevisadas: Number(valor.cuotasRevisadas ?? 0), importadas: Number(valor.importadas ?? 0),
			yaImportadas: Number(valor.yaImportadas ?? 0), marcadasPagadas: Number(valor.marcadasPagadas ?? 0),
			abonosParciales: Number(valor.abonosParciales ?? 0), excluidas: Number(valor.excluidas ?? 0),
			frenadas: Number(valor.frenadas ?? 0), montoImportadoCents: Number(valor.montoImportadoCents ?? 0),
			clientesNuevos: Number(valor.clientesNuevos ?? 0),
		}
	} catch {
		return {
			cuotasRevisadas: 0, importadas: 0, yaImportadas: 0, marcadasPagadas: 0,
			abonosParciales: 0, excluidas: 0, frenadas: 0, montoImportadoCents: 0, clientesNuevos: 0,
		}
	}
}
