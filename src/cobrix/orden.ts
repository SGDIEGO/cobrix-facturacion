/**
 * Orden de las tablas del panel. El nombre de columna NUNCA se interpola en el SQL: cada
 * tabla declara una lista blanca que mapea clave -> expresion SQL, y lo que no este en la
 * lista se ignora y cae al orden por defecto.
 */

export type Direccion = 'asc' | 'desc'

export interface Orden {
	/** Clave de la columna (siempre dentro de la lista blanca). */
	readonly clave: string
	readonly direccion: Direccion
}

/** Lee `orden` y `direccion` de la URL validandolos contra la lista blanca. */
export function leerOrden(params: URLSearchParams, permitidas: readonly string[], porDefecto: string, direccionPorDefecto: Direccion = 'asc'): Orden {
	const clave = params.get('orden') ?? ''
	const direccion: Direccion = params.get('direccion') === 'desc' ? 'desc' : 'asc'
	const valida = permitidas.includes(clave)
	return { clave: valida ? clave : porDefecto, direccion: valida ? direccion : direccionPorDefecto }
}

/** Columnas ordenables de cada tabla con su expresion SQL. */
export const ORDEN = {
	clientes: {
		nombre: 'c.nombre', documento: 'c.documento', tipo: 'c.tipo',
		contratos: 'contratos', abiertas: 'abiertas', pagadas: 'pagadas',
		deuda: 'deuda', vence_antiguo: 'mas_antiguo',
	},
	corridas: {
		id: 'id', tipo: 'tipo', inicio: 'iniciada_en', simulacion: 'simulacion', estado: 'estado',
	},
	items: {
		contrato: 'CAST(contrato_externo AS INTEGER)', cuota: 'CAST(cuota_id AS INTEGER)',
		cliente: 'cliente_nombre', monto: 'monto_cents', resultado: 'resultado', motivo: 'motivo',
	},
	facturas: {
		numero: 'numero', cuota: 'CAST(id_externo AS INTEGER)', contrato: 'CAST(contrato_externo AS INTEGER)',
		periodo: 'periodo', vencimiento: 'vencimiento', corte: 'corte',
		total: 'total_cents', saldo: 'saldo_cents', estado: 'estado', pagada: 'pagada_en',
	},
	contratos: {
		id: 'id_externo', estado: 'estado', plan: 'plan', sucursal: 'sucursal', precio: 'precio_cents',
	},
	deudores: {
		cliente: 'nombre', vencidas: 'vencidas', deuda: 'deuda',
	},
} as const satisfies Record<string, Record<string, string>>

export type TablaOrden = keyof typeof ORDEN

/** Claves ordenables de una tabla. */
export const clavesOrden = (tabla: TablaOrden): readonly string[] => Object.keys(ORDEN[tabla])

/** `ORDER BY <expresion> ASC|DESC` validado para la tabla pedida. */
export function orderDe(tabla: TablaOrden, orden: Orden, porDefecto: string, direccionPorDefecto: Direccion = 'asc'): string {
	const permitidas = ORDEN[tabla] as Record<string, string>
	const valida = permitidas[orden.clave] !== undefined
	const clave = valida ? orden.clave : porDefecto
	const direccion = (valida ? orden.direccion : direccionPorDefecto) === 'desc' ? 'DESC' : 'ASC'
	const expresion = permitidas[clave] ?? 'id'
	return `ORDER BY ${expresion} ${direccion}`
}
