/**
 * Corrida automatica diaria (seccion 3.1): a la hora configurada en America/Caracas importa
 * y despues actualiza pagadas. Vive en el proceso del panel; en un despliegue real esto seria
 * un cron o una cola, y el panel solo mostraria el resultado.
 */

import type { Almacen } from './almacen.ts'

const ZONA = 'America/Caracas'

export interface OpcionesPlanificador {
	readonly almacen: Almacen
	readonly ejecutar: () => Promise<void>
	readonly log?: ((mensaje: string) => void) | undefined
}

export interface Planificador {
	iniciar(): void
	detener(): void
	proxima(): Date | null
}

/** Minutos que hay que sumarle a la hora local de la zona para llegar a UTC (Caracas: +240). */
export function offsetZona(fecha: Date, zona: string = ZONA): number {
	const partes = new Intl.DateTimeFormat('en-CA', {
		timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit',
		hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
	}).formatToParts(fecha)
	const valor = (tipo: string): number => Number(partes.find(parte => parte.type === tipo)?.value ?? 0)
	const local = Date.UTC(valor('year'), valor('month') - 1, valor('day'), valor('hour'), valor('minute'), valor('second'))
	return Math.round((fecha.getTime() - local) / 60_000)
}

/** Convierte una hora local de la zona en un instante UTC. */
export function aInstanteUtc(anio: number, mes: number, dia: number, hora: number, minuto: number, zona: string = ZONA): Date {
	const base = Date.UTC(anio, mes - 1, dia, hora, minuto)
	let instante = base
	for (let i = 0; i < 3; i++) {
		const corregido = base + offsetZona(new Date(instante), zona) * 60_000
		if (corregido === instante) break
		instante = corregido
	}
	return new Date(instante)
}

/** Fecha civil (YYYY-MM-DD) de la zona para un instante dado. */
export function fechaCivil(fecha: Date, zona: string = ZONA): string {
	return new Intl.DateTimeFormat('en-CA', { timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit' }).format(fecha)
}

/** Proxima vez que toca correr: hoy a la hora configurada, o manana si ya paso. */
export function proximaEjecucion(hora: string, desde: Date, zona: string = ZONA): Date {
	const [horas, minutos] = hora.split(':').map(Number) as [number, number]
	const [anio, mes, dia] = fechaCivil(desde, zona).split('-').map(Number) as [number, number, number]
	for (const salto of [0, 1]) {
		const candidato = new Date(Date.UTC(anio, mes - 1, dia + salto, 12, 0))
		const [y, m, d] = fechaCivil(candidato, zona).split('-').map(Number) as [number, number, number]
		const instante = aInstanteUtc(y, m, d, horas, minutos, zona)
		if (instante.getTime() > desde.getTime()) return instante
	}
	return aInstanteUtc(anio, mes - 1, dia + 2, horas, minutos, zona)
}

export function crearPlanificador(opciones: OpcionesPlanificador): Planificador {
	let temporizador: ReturnType<typeof setTimeout> | null = null
	let proxima: Date | null = null
	let corriendo = false

	const programar = (): void => {
		const config = opciones.almacen.leerConfig()
		if (!config.corridaAutomatica) {
			proxima = null
			return
		}
		proxima = proximaEjecucion(config.horaCorrida, new Date())
		const espera = Math.max(1_000, proxima.getTime() - Date.now())
		temporizador = setTimeout(async () => {
			if (corriendo) return
			corriendo = true
			opciones.log?.(`Corrida automatica (${config.horaCorrida} America/Caracas): inicio`)
			try {
				await opciones.ejecutar()
				opciones.log?.('Corrida automatica: terminada')
			} catch (error) {
				opciones.log?.(`Corrida automatica fallida: ${error instanceof Error ? error.message : String(error)}`)
			} finally {
				corriendo = false
				programar()
			}
		}, espera)
	}

	return {
		iniciar: () => {
			if (temporizador !== null) return
			programar()
		},
		detener: () => {
			if (temporizador !== null) clearTimeout(temporizador)
			temporizador = null
			proxima = null
		},
		proxima: () => proxima,
	}
}
