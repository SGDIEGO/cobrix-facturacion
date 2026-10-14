# Tu integración va aquí

Este directorio está vacío a propósito. Aquí vive el lado de Cobrix:

- un **cliente HTTP** de la API del administrador (login con token de 2 horas, contratos, cuotas, libro de pagos);
- la **lectura estricta** de las respuestas: lo inesperado no se adivina;
- la **importación** y la **actualización de pagadas**, cada una con su modo de simulación;
- el **almacenamiento** de Cobrix: empresa, proveedor, clientes, contratos, facturas, corridas e historial. Usa lo que prefieras; Node 24 trae `node:sqlite`.

Conecta tus pantallas en `src/web/app.ts`, donde cada pantalla tiene hoy un «Por implementar».

Las reglas están en [`docs/ENUNCIADO.md`](../../docs/ENUNCIADO.md) §4 y la API en [`docs/API.md`](../../docs/API.md).
