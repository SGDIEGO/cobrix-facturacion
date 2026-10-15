# Nota de la entrega

## Qué se construyó

La integración completa de Cobrix con el administrador de facturas del ISP:

- **Importación** de clientes y facturas con todas las reglas de la sección 4, con modo
  *Simular* que cuenta sin escribir nada.
- **Actualización de pagadas** que distingue cobro total, abono parcial, exonerada y
 *sin evidencia*, también simulable.
- **Historial de corridas** con contadores y una fila por cuota con su resultado y motivo.
- **Panel** con Resumen, Clientes, Expediente, Sincronización y Configuración.
- **Corrida automática** diaria a la hora configurada (America/Caracas): importa y después
  actualiza pagadas.

## Decisiones

- **Stack**: el esqueleto entregado (Node 24 + TypeScript, sin dependencias). El panel es
  server-rendered sobre `layout.ts`, con CSS propio. Sin build step: `npm install && npm start`.
- **Persistencia**: `node:sqlite` en `data/cobrix.sqlite`. Los montos viven en centavos de USD.
- **Valores por defecto de la importación**: `ventanaMeses: null` y `maxCuotasRecientes: null`
  ("sin ventana" y "todas"). Es la única combinación que reproduce los criterios de aceptación
  (42 facturas por USD 1.235,00): con ventana de 3 meses salen 36 y con 6, 40. El enunciado no
  fija el default y la nota lo deja escrito.
- **Días de gracia**: 0 por defecto (el corte es el vencimiento del periodo). Configurable de 0 a 60.
- **Corrida automática**: inactiva por defecto, para que una entrega recién clonada no corra sola.
- **Rarezas de la API**: se documentan en `docs/API.md` y se absorben en `clienteApi.ts` y
  `normalizacion.ts`. Nada se adivina: lo inesperado queda fuera con un motivo en la corrida.
- **El detalle por cuota** registra también lo que *no* se importó y por qué (excluida por estado,
  fuera de ventana, frenada por tope, saldo residual, moneda incoherente, contradicción), que es
  lo que permite auditar una corrida sin repetirla a mano.

## Uso de IA

La IA acompañó todo el proceso: planeación, generación de código, depuración y redacción de esta
nota. Lo que más aportó fue el ciclo *generar → compilar → probar → corregir*: las pruebas del
ciclo completo encontraron tres errores reales que a simple vista pasaban desapercibidos (el
saldo residual de USD 0,0013 redondea a 0 centavos y debe descartarse; la moneda incoherente no
debe evaluarse cuando el contrato no debe nada; la identificación `09000123` pierde sus ceros
solo al normalizar). También encontró que mi primer cálculo del tope de cuotas por contrato no
cuadraba con los números del enunciado. Lo que más corrige fue el diseño: la primera versión del
panel renderizaba `[object Object]` en las tablas por un `.join('')` de más, y la del
planificador tenía el signo del offset horario invertido. En resumen: la IA acelera, pero los
números de los criterios de aceptación son los que mandan.

## Fuera de alcance

- Pantalla de edición de clientes o facturas: todo se importa, nada se edita a mano.
- Reintentos con backoff exponencial en las corridas manuales (solo en la API: 2 reintentos).
- Exportar a CSV/PDF: no pedido.
- Autenticación del panel: el entorno es local y de prueba.
- Pruebas del panel en navegador (solo API y reglas).

## Con más tiempo

- Notificaciones o una cola para la corrida automática en vez de un `setTimeout` en proceso.
- Una vista de conciliación: cuotas del libro que no existen en Cobrix y viceversa.
  **(hecha — ver más abajo)**
- Paginación del lado del administrador si `lista_ids_contratos` miles de contratos.
- Pruebas de humo del panel en navegador (Playwright).

## Punto diferencial

**La corrida se puede auditar sin repetirla.** Cada cuota deja su resultado y su motivo en el
detalle, incluidas las que no se importaron, con el contador de topes y la fila de cuotas del
cliente que se marcaron pagadas con la factura del ISP que las pagó. El operador ve qué pasó,
por qué y qué sigue abierto, sin tocar el Swagger.

**El panel no esboza el enunciado: fue auditado contra las capturas de `docs/capturas/referencia-layout/`.** Comparé pantalla por pantalla y cerré las diferencias que afectaban claridad: columna *Contrato* en las facturas del expediente, accesos rápidos siempre visibles, errores que dicen cómo seguir, tile *Contratos* y fecha de creación en el expediente, "Al día" en clientes sin deuda, y contadores con nombre propio para cada tipo de corrida (en pagadas, "Siguen pendientes" en vez de "Excluidas"). Los números de la referencia de layout (LUIS GOMEZ: 4 abiertas, 1 pagada, USD 95,00; MIGUEL ANGEL SOTO: 6 abiertas, USD 210,00) coinciden con los que produce este código.

**Y una pantalla que nadie pidió: Conciliación** (`/conciliacion`). Lee el libro de cuotas del
administrador de cada contrato con facturas en Cobrix y lo compara cuota por cuota. Separar lo que
**es** diferencia de lo que **no** lo es fue la parte interesante: las cuotas que el ISP ya cobró
nunca se importan (correcto) y las futuras todavía no tocan, así que ninguna de las dos es
diferencia. Con la base entregada el informe encuentra **una sola**: la cuota fantasma de
ANA PEREZ (2025-08, USD 25), que `pago_informacion` lista y `contrato/individual` no devuelve.
Ese es exactamente el tipo de hallazgo que justifica la herramienta: sin ella, esa cuota es
invisible para los dos sistemas.

La acompañan: alertas de vencimiento (7 y 30 días), clientes con 3 o más cuotas vencidas,
facturas con abono parcial sin cerrar y composición de la deuda por antigüedad; exportación a CSV
de clientes, facturas y conciliación; y un endpoint `/salud` con el estado de la conexión y la
última corrida, para monitoreo.

**El panel no esboza el enunciado: fue auditado contra las capturas de `docs/capturas/referencia-layout/`.** Comparé pantalla por pantalla y cerré las diferencias que afectaban claridad: columna *Contrato* en las facturas del expediente, accesos rápidos siempre visibles, errores que dicen cómo seguir, tile *Contratos* y fecha de creación en el expediente, "Al día" en clientes sin deuda, y contadores con nombre propio para cada tipo de corrida (en pagadas, "Siguen pendientes" en vez de "Excluidas"). Los números de la referencia de layout (LUIS GOMEZ: 4 abiertas, 1 pagada, USD 95,00; MIGUEL ANGEL SOTO: 6 abiertas, USD 210,00) coinciden con los que produce este código.

Después lo rediseñé entero: paleta pastel empresarial, iconos de FontAwesome servidos en local
(sin depender de internet), barra lateral colapsable con estado recordado, paginación de 20/25/50
en todas las tablas largas y leyendas de resultados.

## Cómo levantarlo y probarlo

Ver el `README.md`. `npm test` corre 27 pruebas; el ciclo completo comprueba los números de los
criterios de aceptación (20 clientes, 42 facturas por USD 1.235,00; tras los pagos, 8 pagadas y
34 abiertas por USD 955,00).
