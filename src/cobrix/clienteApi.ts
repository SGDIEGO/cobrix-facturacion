/**
 * Cliente HTTP del administrador de facturas. Solo habla por HTTP, como con un ISP real.
 *
 * Rarezas de la API que este cliente absorbe:
 *   - el token dura 2 horas, su vencimiento viene en UTC sin zona y no se renueva: se pide otro login;
 *   - `pago_informacion` responde `success: false` aunque traiga datos: ese campo se ignora;
 *   - `contrato/individual` devuelve una lista sin envoltorio;
 *   - `lista_ids_contratos` ignora la paginacion y, si se manda `estado`, filtra solo activos.
 */

export class ErrorApi extends Error {
	readonly tipo: 'auth' | 'http' | 'red' | 'parseo' | 'parametros'
	readonly status: number | undefined
	constructor(tipo: 'auth' | 'http' | 'red' | 'parseo' | 'parametros', message: string, status?: number) {
		super(message)
		this.name = 'ErrorApi'
		this.tipo = tipo
		this.status = status
	}
}

export interface CuotaPendiente {
	readonly contratoId: number
	readonly codigo: string
	readonly identificacion: string
	readonly nombre: string
	readonly telefono: string
	readonly email: string
	readonly estado: string
	readonly plan: string
	readonly precioPlan: number
	readonly moneda: string
	readonly monedaSigla: string
	readonly sucursal: string
	readonly deuda: number
	readonly deudaId: string
	readonly detalleDeuda: readonly string[]
}

export interface FilaLibro {
	readonly facturaId: number
	readonly numFactura: string
	readonly fechaEmision: string
	readonly contratoId: number
	readonly cuotaId: number
	readonly periodoCuota: string
	readonly tarifa: number
	readonly valorPago: number
	readonly saldoCuota: number
	readonly descuento: number
}

export interface OpcionesCliente {
	readonly baseUrl: string
	readonly usuario: string
	readonly password: string
	readonly tiempoDeEsperaMs?: number
	readonly fetchImpl?: typeof fetch
	readonly ahora?: () => Date
}

interface Token {
	readonly valor: string
	readonly expiraEn: number
}

const MENSAJE_ERROR = (cuerpo: unknown): string => {
	if (cuerpo && typeof cuerpo === 'object') {
		const detalle = (cuerpo as { detail?: unknown }).detail
		if (detalle && typeof detalle === 'object') {
			const mensaje = (detalle as { mensaje?: unknown }).mensaje
			if (typeof mensaje === 'string' && mensaje) return mensaje
		}
		if (typeof detalle === 'string' && detalle) return detalle
		const lista = (cuerpo as { errors?: unknown }).errors
		if (Array.isArray(lista) && lista.length > 0) {
			const primero = lista[0] as { message?: unknown }
			if (typeof primero?.message === 'string') return primero.message
		}
	}
	return 'la API no dio un motivo'
}

export class ClienteApi {
	private token: Token | null = null
	private readonly tiempoDeEsperaMs: number
	private readonly fetchImpl: typeof fetch
	private readonly ahora: () => Date
	private readonly opciones: OpcionesCliente

	constructor(opciones: OpcionesCliente) {
		this.opciones = opciones
		this.tiempoDeEsperaMs = opciones.tiempoDeEsperaMs ?? 15_000
		this.fetchImpl = opciones.fetchImpl ?? fetch
		this.ahora = opciones.ahora ?? (() => new Date())
	}

	get baseUrl(): string {
		return this.opciones.baseUrl.replace(/\/+$/, '')
	}

	conCredenciales(baseUrl: string, usuario: string, password: string): ClienteApi {
		return new ClienteApi({ ...this.opciones, baseUrl, usuario, password })
	}

	/** Inicia sesion y guarda el token. Falla con `auth` si las credenciales no sirven. */
	async iniciarSesion(): Promise<void> {
		const respuesta = await this.enviar('POST', '/api/v1/usuario/login', {
			body: JSON.stringify({ user_name: this.opciones.usuario, password: this.opciones.password }),
			reintentar: 0,
		})
		const cuerpo = (respuesta ?? {}) as Record<string, unknown>
		const token = typeof cuerpo.access_token === 'string' ? cuerpo.access_token : ''
		if (!token) throw new ErrorApi('parseo', 'el login no devolvio access_token')
		const vence = typeof cuerpo.access_token_expires_in === 'string'
			? Date.parse(`${String(cuerpo.access_token_expires_in)}Z`)
			: Number.NaN
		// Margen de 5 minutos: si vence en plena corrida, mejor pedir otro antes.
		const expiraEn = Number.isFinite(vence) ? vence - 300_000 : this.ahora().getTime() + 7_000_000
		this.token = { valor: token, expiraEn }
	}

	private tokenVigente(): boolean {
		return this.token !== null && this.token.expiraEn > this.ahora().getTime()
	}

	private async conToken<T>(leer: (auth: string) => Promise<T>): Promise<T> {
		if (!this.tokenVigente()) await this.iniciarSesion()
		try {
			return await leer(this.token!.valor)
		} catch (error) {
			const esAuth = error instanceof ErrorApi && (error.tipo === 'auth' || (error.status ?? 0) === 401)
			if (!esAuth || this.token === null) throw error
			this.token = null
			await this.iniciarSesion()
			return await leer(this.token!.valor)
		}
	}

	/** Todos los contratos del administrador. Sin `estado` a proposito: con cualquier valor la API filtra solo activos. */
	async idsContratos(): Promise<number[]> {
		return await this.conToken(async auth => {
			const respuesta = await this.enviar('GET', '/api/v1/isp/lista_ids_contratos', { auth })
			const data = (respuesta as { data?: unknown } | null)?.data
			if (!Array.isArray(data)) throw new ErrorApi('parseo', 'lista_ids_contratos no devolvio una lista en data')
			return data.map(item => Number(item)).filter(id => Number.isInteger(id))
		})
	}

	/** Cuotas pendientes de un contrato: una fila por cuota, sin orden. */
	async cuotasContrato(idContrato: number): Promise<CuotaPendiente[]> {
		return await this.conToken(async auth => {
			const cuerpo = await this.enviar('GET', `/api/v1/isp/contrato/individual?id_contrato=${idContrato}`, { auth })
			const filas = Array.isArray(cuerpo) ? cuerpo : null
			if (!filas) throw new ErrorApi('parseo', `contrato/individual de ${idContrato} no devolvio una lista`)
			return filas.map(fila => this.leerCuota(fila))
		})
	}

	/** Libro de cuotas y pagos de un contrato. Incluye cuotas futuras: hay que filtrarlas. */
	async libroCuotas(idContrato: number, desde: string, hasta: string): Promise<FilaLibro[]> {
		return await this.conToken(async auth => {
			const params = new URLSearchParams({ id_contrato: String(idContrato), tipo_busqueda: 'CUOTA', fecha_inicio: desde, fecha_fin: hasta })
			const respuesta = await this.enviar('GET', `/api/v1/isp/pago_informacion?${params.toString()}`, { auth })
			const data = (respuesta as { data?: unknown } | null)?.data
			if (!Array.isArray(data)) throw new ErrorApi('parseo', `pago_informacion de ${idContrato} no devolvio una lista en data`)
			return data.map(fila => this.leerFilaLibro(fila, idContrato))
		})
	}

	/** Para el boton "Probar conexion": cantidad de contratos que ve el usuario. */
	async probarConexion(): Promise<{ contratos: number; usuario: string }> {
		const ids = await this.idsContratos()
		return { contratos: ids.length, usuario: this.opciones.usuario }
	}

	private leerCuota(fila: unknown): CuotaPendiente {
		const f = (fila ?? {}) as Record<string, unknown>
		const contratoId = Number(f.contrato_id)
		if (!Number.isInteger(contratoId)) throw new ErrorApi('parseo', `cuota sin contrato_id valido: ${JSON.stringify(fila).slice(0, 120)}`)
		const plan = typeof f.nombre_plan === 'string' ? f.nombre_plan : ''
		const precioPlan = Number(f.precio_servicio)
		const numerico = (valor: unknown): number => (typeof valor === 'number' ? valor : Number(valor))
		return {
			contratoId,
			codigo: String(f.codigo ?? ''),
			identificacion: String(f.identificacion_contrato ?? ''),
			nombre: String(f.nombre_contrato ?? '').trim(),
			telefono: String(f.telefono ?? ''),
			email: String(f.email ?? '').trim(),
			estado: String(f.estado ?? '').trim().toUpperCase(),
			plan,
			precioPlan: Number.isFinite(precioPlan) ? precioPlan : Number.NaN,
			moneda: String(f.moneda ?? ''),
			monedaSigla: String(f.moneda_sigla ?? '').trim().toUpperCase(),
			sucursal: String(f.sigla_sucursal ?? f.nombre_sucursal ?? ''),
			deuda: numerico(f.deuda),
			deudaId: String(f.deuda_id ?? '').trim(),
			detalleDeuda: Array.isArray(f.detalle_deuda) ? f.detalle_deuda.filter((v): v is string => typeof v === 'string') : [],
		}
	}

	private leerFilaLibro(fila: unknown, idPedido: number): FilaLibro {
		const f = (fila ?? {}) as Record<string, unknown>
		const detalle = (f.detalle_pago ?? {}) as Record<string, unknown>
		const numerico = (valor: unknown): number => (typeof valor === 'number' ? valor : Number(valor))
		return {
			facturaId: numerico(f.id_factura),
			numFactura: String(f.num_factura ?? ''),
			fechaEmision: String(f.fecha_emision ?? '').slice(0, 10),
			contratoId: numerico(detalle.id_contrato) || numerico(f.id_contrato) || idPedido,
			cuotaId: numerico(detalle.id_cuota),
			periodoCuota: String(detalle.periodo_cuota ?? ''),
			tarifa: numerico(detalle.tarifa),
			valorPago: numerico(detalle.valor_pago),
			saldoCuota: numerico(detalle.saldo_cuota),
			descuento: numerico(detalle.descuento),
		}
	}

	private async enviar(
		metodo: 'GET' | 'POST',
		ruta: string,
		opciones: { auth?: string | undefined; body?: string | undefined; reintentar?: number | undefined } = {},
	): Promise<unknown> {
		const reintentos = opciones.reintentar ?? 2
		let ultimoError: ErrorApi | null = null
		for (let intento = 0; intento <= reintentos; intento++) {
			try {
				const respuesta = await this.fetchImpl(`${this.baseUrl}${ruta}`, {
					method: metodo,
					headers: {
						accept: 'application/json',
						...(metodo === 'POST' ? { 'content-type': 'application/json' } : {}),
						...(opciones.auth ? { authorization: `Bearer ${opciones.auth}` } : {}),
					},
					body: opciones.body,
					signal: AbortSignal.timeout(this.tiempoDeEsperaMs),
				})
				const texto = await respuesta.text()
				let cuerpo: unknown = {}
				if (texto) {
					try {
						cuerpo = JSON.parse(texto) as unknown
					} catch {
						throw new ErrorApi('parseo', `la API devolvio algo que no es JSON (HTTP ${respuesta.status})`, respuesta.status)
					}
				}
				if (respuesta.status === 401) throw new ErrorApi('auth', MENSAJE_ERROR(cuerpo) || 'token rechazado', 401)
				if (respuesta.status === 400) throw new ErrorApi('parametros', MENSAJE_ERROR(cuerpo), 400)
				if (!respuesta.ok) throw new ErrorApi('http', `la API respondio HTTP ${respuesta.status}: ${MENSAJE_ERROR(cuerpo)}`, respuesta.status)
				return cuerpo
			} catch (error) {
				if (error instanceof ErrorApi) {
					// auth y parametros son definitivos: no se reintentan.
					if (error.tipo === 'auth' || error.tipo === 'parametros' || error.tipo === 'parseo') throw error
					ultimoError = error
				} else {
					ultimoError = new ErrorApi('red', error instanceof Error ? error.message : 'fallo de red')
				}
				if (intento < reintentos) await new Promise(resolve => setTimeout(resolve, 250 * (intento + 1)))
			}
		}
		throw ultimoError ?? new ErrorApi('red', 'no se pudo hablar con la API')
	}
}
