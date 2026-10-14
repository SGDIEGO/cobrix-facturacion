/**
 * Reglas de negocio de la seccion 4 del enunciado: normalizacion de identificaciones,
 * periodo y fecha de corte, ventana de importacion y decisiones que no se adivinan.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
	aCentavos, esFilaSinDeuda, esSaldoResidual, fechaCorte, leerPeriodo,
	normalizarIdentificacion, periodoMenos, sumarMeses, tipoPersona, ultimoDiaDelPeriodo, vencimientoDePeriodo,
} from '../src/cobrix/normalizacion.ts'
import { fusionarConfig } from '../src/cobrix/almacen.ts'
import { CONFIG_POR_DEFECTO } from '../src/cobrix/tipos.ts'
import { proximaEjecucion, offsetZona, fechaCivil } from '../src/cobrix/planificador.ts'

describe('identificacion del titular', () => {
	it('normaliza letra, separadores y ceros a la izquierda', () => {
		const id1 = normalizarIdentificacion('V-12345678'); assert.ok(id1.ok); assert.equal(id1.valor.documento, 'V12345678')
		const id2 = normalizarIdentificacion('09000123'); assert.ok(id2.ok); assert.equal(id2.valor.documento, '9000123')
		const id3 = normalizarIdentificacion('v-12345678'); assert.ok(id3.ok); assert.equal(id3.valor.documento, 'V12345678')
		const id4 = normalizarIdentificacion('J-40123456-7'); assert.ok(id4.ok); assert.equal(id4.valor.documento, 'J401234567')
		const id5 = normalizarIdentificacion(' V12345678 '); assert.ok(id5.ok); assert.equal(id5.valor.documento, 'V12345678')
	})

	it('rechaza lo que no puede interpretar, sin adivinar', () => {
		for (const valor of ['', '   ', '12345', '1234567890123', 'X-123456', 'V--12345678', null, 12, undefined]) {
			assert.equal(normalizarIdentificacion(valor).ok, false, `"${String(valor)}" no deberia pasar`)
		}
	})

	it('J y G son personas juridicas', () => {
		assert.equal(tipoPersona('J'), 'juridica')
		assert.equal(tipoPersona('G'), 'juridica')
		assert.equal(tipoPersona('V'), 'natural')
		assert.equal(tipoPersona('E'), 'natural')
		assert.equal(tipoPersona(null), 'natural')
	})
})

describe('periodo, vencimiento y corte', () => {
	it('saca el periodo de la etiqueta del administrador', () => {
		const per1 = leerPeriodo(['PLAN15MB25 - 2026 Agosto']); assert.ok(per1.ok); assert.equal(per1.valor, '2026-08')
		const per2 = leerPeriodo(['PLAN3MB20 - 2026 Septiembre']); assert.ok(per2.ok); assert.equal(per2.valor, '2026-09')
		const per3 = leerPeriodo(['PLAN - 2026 Diciembre']); assert.ok(per3.ok); assert.equal(per3.valor, '2026-12')
		assert.equal(leerPeriodo(['sin periodo']).ok, false)
		assert.equal(leerPeriodo([]).ok, false)
	})

	it('el vencimiento es el primer dia del periodo y el corte suma los dias de gracia', () => {
		assert.equal(vencimientoDePeriodo('2026-08'), '2026-08-01')
		assert.equal(fechaCorte('2026-08-01', 0), '2026-08-01')
		assert.equal(fechaCorte('2026-08-01', 10), '2026-08-11')
		assert.equal(fechaCorte('2026-01-31', 5), '2026-02-05')
	})

	it('la ventana se mide en meses', () => {
		assert.equal(periodoMenos('2026-10', 3), '2026-07')
		assert.equal(periodoMenos('2026-01', 3), '2025-10')
		assert.equal(periodoMenos('2026-10', 12), '2025-10')
		assert.equal(sumarMeses('2026-12', 1), '2027-01')
		assert.equal(ultimoDiaDelPeriodo('2026-02'), '2026-02-28')
	})
})

describe('montos y filas que no son cuotas', () => {
	it('los centavos redondean y los residuales se descartan', () => {
		assert.equal(aCentavos(20), 2_000)
		assert.equal(aCentavos('25.5'), 2_550)
		assert.equal(aCentavos(0.001317), 0)
		assert.equal(aCentavos(0.005), 1)
		assert.equal(esSaldoResidual(0), true, 'una deuda de 0 centavos no es cuota')
		assert.equal(esSaldoResidual(1), false)
	})

	it('la fila deuda_id 0 significa que el contrato no debe nada', () => {
		assert.equal(esFilaSinDeuda('0'), true)
		assert.equal(esFilaSinDeuda(' 0 '), true)
		assert.equal(esFilaSinDeuda('7000008'), false)
	})
})

describe('configuracion', () => {
	it('los defaults reproducen los criterios de aceptacion', () => {
		assert.equal(JSON.stringify(CONFIG_POR_DEFECTO.estadosImportables), JSON.stringify(['ACTIVO','CORTADO']))
		assert.equal(CONFIG_POR_DEFECTO.ventanaMeses, null)
		assert.equal(CONFIG_POR_DEFECTO.maxCuotasRecientes, null)
	})

	it('lo guardado se fusiona con los defaults y se acota', () => {
		assert.equal(JSON.stringify(fusionarConfig(null).estadosImportables), JSON.stringify(['ACTIVO','CORTADO']))
		assert.equal(JSON.stringify(fusionarConfig({ estadosImportables: ['activo','RETIRADO',' inventado '] }).estadosImportables), JSON.stringify(['ACTIVO','RETIRADO']))
		assert.equal(fusionarConfig({ ventanaMeses: 6 }).ventanaMeses, 6)
		assert.equal(fusionarConfig({ ventanaMeses: 7 }).ventanaMeses, null, 'solo 3, 6, 9, 12 o sin ventana')
		assert.equal(fusionarConfig({ ventanaMeses: 'todas' }).ventanaMeses, null)
		assert.equal(fusionarConfig({ maxCuotasRecientes: 999 }).maxCuotasRecientes, 60)
		assert.equal(fusionarConfig({ diasGracia: -5 }).diasGracia, 0)
		assert.equal(fusionarConfig({ diasGracia: 100 }).diasGracia, 60)
		assert.equal(JSON.stringify(fusionarConfig({ excluirTiposDocumento: ['j', 'Z'] }).excluirTiposDocumento), JSON.stringify(['J']))
		assert.equal(fusionarConfig({ corridaAutomatica: 'true' }).corridaAutomatica, true)
		assert.equal(fusionarConfig({ horaCorrida: '25:00' }).horaCorrida, '02:00')
	})
})

describe('corrida automatica', () => {
	it('America/Caracas va 4 horas por detras de UTC', () => {
		assert.equal(offsetZona(new Date('2026-10-13T18:00:00Z')), 240, 'Caracas va 4 horas por detras de UTC')
	})

	it('la proxima corrida cae en la hora pedida de la zona', () => {
		const desde = new Date('2026-10-13T09:00:00Z')
		const proxima = proximaEjecucion('07:30', desde)
		assert.equal(fechaCivil(proxima) + ' ' + new Intl.DateTimeFormat('en-CA', {
			timeZone: 'America/Caracas', hour: '2-digit', minute: '2-digit', hour12: false,
		}).format(proxima), '2026-10-13 07:30')
	})

	it('si la hora ya paso, cae manana', () => {
		const desde = new Date('2026-10-13T12:00:00Z')
		const proxima = proximaEjecucion('02:00', desde)
		assert.equal(fechaCivil(proxima), '2026-10-14')
		assert.equal(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', hour: '2-digit', minute: '2-digit', hour12: false }).format(proxima), '02:00')
	})
})
