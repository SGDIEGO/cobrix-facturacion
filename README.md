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

### Crear un pago y sincronizarlo

El pago se registra en la caja del ISP y Cobrix se entera al correr *Actualizar pagadas*:

```bash
# pago completo de todas las cuotas pendientes del contrato
curl -X POST http://127.0.0.1:4310/__sim/pagar -H 'content-type: application/json' \
  -d '{"id_contrato": 900101}'

# abono parcial (paga las mas viejas primero)
curl -X POST http://127.0.0.1:4310/__sim/pagar -H 'content-type: application/json' \
  -d '{"id_contrato": 900103, "monto": 25}'

# cuotas especificas
curl -X POST http://127.0.0.1:4310/__sim/pagar -H 'content-type: application/json' \
  -d '{"id_contrato": 900114, "id_cuotas": [7000088, 7000089]}'

# anular un cobro: las cuotas vuelven a deber
curl -X POST http://127.0.0.1:4310/__sim/anular -H 'content-type: application/json' \
  -d '{"id_factura": 8800118}'
```

Para saber los IDs reales de cada contrato: `GET /__sim/contratos` (lista `pendientes` por
contrato) o `GET /api/v1/isp/contrato/individual?id_contrato=900114` con el token del login.

Si el ISP anula un cobro **después** de que Cobrix ya lo sincronizó, la siguiente corrida de
*Actualizar pagadas* reabre esas facturas con el saldo que el libro indique (resultado
*reabierta* en el detalle). Si la anulación ocurre **antes** de sincronizar, simplemente no se
marca nada como pagado.

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
  Diseño minimalista (paleta pastel azul polvo sobre grises cálidos, con modo oscuro), iconos de
  FontAwesome 6 **servidos localmente** desde `src/web/assets/fontawesome` (funciona sin internet),
  barra lateral colapsable (tira de iconos en escritorio, cajón en móvil, estado recordado) y
  paginación de 20/25/50 filas en todas las tablas largas.
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

## Diseño del panel

Minimalista y empresarial, sobre el esqueleto entregado:

- **Paleta pastel** (azul polvo `#5b7fa8` sobre grises cálidos) con modo oscuro coherente; una sola
  familia tipográfica, escala cerrada y cifras alineadas para los montos.
- **FontAwesome 6 servido localmente** (`src/web/assets/fontawesome`): el panel no depende de internet.
- **Barra lateral colapsable**: en escritorio queda como tira de iconos con tooltip; en móvil es un
  cajón que se cierra con la X, con `Escape` o tocando el fondo. El estado se recuerda en el navegador.
- **Paginación** de 20/25/50 filas (20 por defecto) en clientes, corridas, detalle de corrida,
  facturas del expediente e historial, con `« ‹ 1 2 3 … 10 › »` y el recuento "Mostrando 1–20 de 84".
- **Leyendas**: qué significa cada resultado de corrida (importada, ya importada, frenada por tope,
  abono parcial, exonerada, sin evidencia…) y notas de ayuda donde la operación lo pide.

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
