# Cobrix · Integración con el administrador de facturas de un ISP

Prueba técnica: importar clientes y facturas desde la API de un administrador de facturas,
aplicar los pagos que el ISP ya cobró y construir el panel para operarlo.

## Levantar el entorno

Requiere **Node 24**.

```bash
npm install
npm start
```

| Qué | Dónde |
| --- | --- |
| Panel de Cobrix | http://127.0.0.1:4300 |
| API del administrador de facturas | http://127.0.0.1:4310/api/v1 |
| Swagger de la API | http://127.0.0.1:4310/docs |

Credenciales de la API: usuario `cobrix`, contraseña `cobrix-sandbox`.

`npm start` fija la fecha de la prueba en **2026-10-13** (`SANDBOX_TODAY`) para que los
números de los criterios de aceptación se cumplan. Para usar la fecha real, quita esa variable.

## Cómo se opera

1. **Configuración**: guarda la empresa y el proveedor (URL, usuario, contraseña) y pulsa
   *Probar conexión*. Ajusta las reglas de importación (estados, ventana, topes, días de gracia,
   exclusión por tipo de documento) y la corrida automática diaria.
2. **Sincronización**: *Simular importación* muestra cuánto se traería sin escribir nada;
   *Importar* crea clientes y facturas. *Actualizar pagadas* marca como pagadas las facturas
   que el ISP ya cobró por completo. Cada corrida queda en el historial con su detalle por cuota.
3. **Clientes**: tabla con búsqueda; cada fila abre el expediente (datos, contratos, facturas
   e historial).

Para crear pagos del lado del ISP y probar *Actualizar pagadas*, usa la sección **Simulador**
del Swagger (`POST /__sim/pagar`, `POST /__sim/anular`).

## Pruebas

```bash
npm test           # 27 pruebas: entorno, reglas de negocio y ciclo completo
npm run typecheck
```

| Archivo | Qué cubre |
| --- | --- |
| `test/entorno.test.ts` | La API entregada responde como se documenta y el panel sirve sus pantallas |
| `test/reglas.test.ts` | Reglas de negocio: identificación, periodo/corte, ventana, montos, configuración, corrida automática |
| `test/ciclo.test.ts` | Ciclo completo: importar → pagar en la caja → actualizar pagadas, con los números de los criterios de aceptación |

## Decisiones técnicas

- **Stack**: el esqueleto entregado (Node 24 + TypeScript, sin dependencias). El panel es
  server-rendered con el `layout.ts` del esqueleto y un CSS propio encima. Sin build step.
- **Persistencia de Cobrix**: `node:sqlite` en `data/cobrix.sqlite` (gitignored). Nunca se lee
  `data/billing-api.sqlite`: la comunicación con el administrador es solo HTTP.
- **Montos**: en centavos de USD (enteros) para no arrastrar errores de punto flotante.
- **Idempotencia**: `factura.id_externo` es el `deuda_id` del administrador y es único; un cliente
  por documento normalizado. Correr la importación dos veces no duplica nada.
- **Simulación**: el mismo camino de cálculo que la corrida real, sin escribir. Los contadores
  de una simulación dicen lo que *se* haría.
- **Rarezas de la API** (ver `docs/API.md`): no se manda `estado` en `lista_ids_contratos`
  (cualquier valor filtra solo activos); se ignora `success` de `pago_informacion`; se filtran
  cuotas futuras y la cuota fantasma; el token de 2 horas se renueva solo al vencer.
- **Nada se adivina**: filas de otro contrato, cuotas duplicadas con datos distintos o filas del
  libro que no coinciden entre sí dejan la factura fuera con un motivo escrito en la corrida.

## Estructura

```
src/cobrix/        el lado de Cobrix
  clienteApi.ts    HTTP del administrador: login, token de 2h, lecturas validadas
  normalizacion.ts identificación, periodo, vencimiento, corte, montos
  almacen.ts       base propia: empresa, proveedor, clientes, facturas, corridas, historial
  importar.ts      corrida de importación (con modo simulación)
  pagadas.ts       corrida de actualización de pagadas (con modo simulación)
  formularios.ts   validación de los formularios del panel
  planificador.ts  corrida automática diaria en America/Caracas
src/web/           panel (app.ts + layout.ts del esqueleto)
src/billing-api/   API simulada del administrador (no se toca)
test/              pruebas de entorno, reglas y ciclo completo
docs/ENUNCIADO.md  enunciado completo
docs/NOTA.md       decisiones, alcance y punto diferencial
```
