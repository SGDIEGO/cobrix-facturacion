/**
 * Lectura de los formularios del panel. Todo lo que llega del navegador se valida aqui:
 * un valor raro se descarta con un mensaje claro en lugar de guardarse a medias.
 */

import type { Config, Empresa, Proveedor } from './tipos.ts'
import { CONFIG_POR_DEFECTO } from './tipos.ts'

export type Entrada = Record<string, string | undefined>

export type Lectura<T> = { readonly ok: true; readonly valor: T } | { readonly ok: false; readonly errores: readonly string[] }

const texto = (valor: string | undefined): string => (valor ?? '').trim()

export function empresaDesdeFormulario(entrada: Entrada): Lectura<Empresa> {
	const nombre = texto(entrada.nombre)
	const rif = texto(entrada.rif)
	const correo = texto(entrada.correo)
	const errores: string[] = []
	if (!nombre) errores.push('el nombre de la empresa es obligatorio')
	if (rif && !/^[VEGJPvejgp]?-?\d{6,12}(-\d)?$/.test(rif)) errores.push('el RIF no tiene un formato valido (ejemplo: J-40123456-7)')
	if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) errores.push('el correo de cobranza no es una direccion valida')
	return errores.length > 0 ? { ok: false, errores } : { ok: true, valor: { nombre, rif, correoCobranza: correo } }
}

export function proveedorDesdeFormulario(entrada: Entrada, actual: Proveedor): Lectura<Proveedor> {
	const url = texto(entrada.url)
	const usuario = texto(entrada.usuario)
	const password = texto(entrada.password)
	const errores: string[] = []
	if (!url) errores.push('la URL de la API es obligatoria')
	else {
		try {
			const parsed = new URL(url)
			if (!['http:', 'https:'].includes(parsed.protocol)) errores.push('la URL debe empezar por http:// o https://')
		} catch {
			errores.push('la URL de la API no es una direccion valida')
		}
	}
	if (!usuario) errores.push('el usuario de la API es obligatorio')
	return errores.length > 0
		? { ok: false, errores }
		: { ok: true, valor: { url: url.replace(/\/+$/, ''), usuario, password: password || actual.password } }
}

const estadosValidos = ['ACTIVO', 'CORTADO', 'CORTESIA', 'RETIRADO', 'RECHAZADO', 'ANULADO']
const documentosValidos = ['V', 'E', 'J', 'G', 'P']

export function configDesdeFormulario(entrada: Entrada): Lectura<Config> {
	const estados = estadosValidos.filter(estado => entrada[`estado_${estado}`] !== undefined)
	const excluir = documentosValidos.filter(doc => entrada[`excluir_${doc}`] !== undefined)
	const ventana = texto(entrada.ventana)
	const recientes = texto(entrada.recientes)
	const errores: string[] = []

	if (estados.length === 0) errores.push('marca al menos un estado de contrato para importar')
	if (!['', '3', '6', '9', '12', 'todas'].includes(ventana)) errores.push('la ventana de importacion debe ser 3, 6, 9, 12 meses o sin ventana')
	if (recientes !== '' && !/^\d+$/.test(recientes)) errores.push('el maximo de cuotas recientes debe ser un numero entero')
	if (recientes !== '' && (Number(recientes) < 1 || Number(recientes) > 60)) errores.push('el maximo de cuotas recientes va de 1 a 60')

	const entero = (valor: string | undefined, min: number, max: number, defecto: number): number | null => {
		const limpio = texto(valor)
		if (limpio === '') return null
		if (!/^\d+$/.test(limpio)) return null
		return Math.min(max, Math.max(min, Number(limpio)))
	}

	const diasGracia = entero(entrada.diasGracia, 0, 60, 0)
	const maxFacturas = entero(entrada.maxFacturas, 1, 100_000, 0)
	const maxMonto = entero(entrada.maxMonto, 1, 100_000_000, 0)
	const hora = texto(entrada.hora)
	if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(hora)) errores.push('la hora de la corrida automatica debe tener el formato HH:MM')

	if (diasGracia === null && texto(entrada.diasGracia) !== '') errores.push('los dias de gracia deben ser un numero entre 0 y 60')

	return errores.length > 0 ? { ok: false, errores } : {
		ok: true,
		valor: {
			estadosImportables: estados,
			ventanaMeses: ventana === '' || ventana === 'todas' ? null : Number(ventana),
			maxCuotasRecientes: recientes === '' ? null : Number(recientes),
			diasGracia: diasGracia ?? 0,
			maxFacturasNuevas: maxFacturas,
			maxMontoNuevoCents: maxMonto === null ? null : Math.round(maxMonto * 100),
			excluirTiposDocumento: excluir,
			corridaAutomatica: entrada.corridaAutomatica !== undefined,
			horaCorrida: hora,
		},
	}
}

/** Resumen legible de la configuracion, para la pantalla de Resumen. */
export function describirConfig(config: Config): string {
	const partes = [
		`estados ${config.estadosImportables.join(' y ')}`,
		config.ventanaMeses === null ? 'sin ventana de meses' : `ventana de ${config.ventanaMeses} meses`,
		config.maxCuotasRecientes === null ? 'sin tope de cuotas por contrato' : `${config.maxCuotasRecientes} cuotas recientes por contrato`,
		config.diasGracia === 0 ? 'corte el dia del vencimiento' : `${config.diasGracia} dias de gracia`,
	]
	if (config.maxFacturasNuevas !== null) partes.push(`tope de ${config.maxFacturasNuevas} facturas por corrida`)
	if (config.maxMontoNuevoCents !== null) partes.push(`tope de USD ${(config.maxMontoNuevoCents / 100).toFixed(2)} por corrida`)
	if (config.excluirTiposDocumento.length > 0) partes.push(`sin documentos ${config.excluirTiposDocumento.join(', ')}`)
	return partes.join(' · ')
}

export const DEFAULTS = CONFIG_POR_DEFECTO
