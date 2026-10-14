/**
 * Base del panel de Cobrix: layout, menu colapsable, iconos FontAwesome locales, estilos y
 * helpers (escapado, dinero, fechas, pestanas de estado).
 *
 * Los assets de FontAwesome viven en `src/web/assets/fontawesome` y se sirven en
 * `/assets/fontawesome/...`: el panel funciona sin internet.
 */

export const esc = (value: unknown): string =>
	String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/** Tagged template que escapa las interpolaciones salvo que sean `raw()`. */
export class Raw {
	readonly html: string
	constructor(html: string) {
		this.html = html
	}
}
export const raw = (html: string): Raw => new Raw(html)
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
	let out = strings[0] ?? ''
	values.forEach((value, i) => {
		const render = (v: unknown): string =>
			v instanceof Raw ? v.html : Array.isArray(v) ? v.map(render).join('') : v === undefined || v === null || v === false ? '' : esc(v)
		out += render(value) + (strings[i + 1] ?? '')
	})
	return new Raw(out)
}

const money = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const usd = (minor: unknown): string => `USD ${money.format(Number(minor ?? 0) / 100)}`

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
export function date(value: unknown): string {
	if (typeof value !== 'string' || !value) return '-'
	const [y, m, d] = value.slice(0, 10).split('-')
	return d ? `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}` : `${MONTHS[Number(m) - 1]} ${y}`
}
export function dateTime(value: unknown): string {
	if (typeof value !== 'string' || !value) return '-'
	return new Intl.DateTimeFormat('es-VE', { timeZone: 'America/Caracas', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}
export const period = (value: unknown): string => (typeof value === 'string' ? date(value) : '-')

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'mute'
export const pill = (label: string, tone: Tone): Raw => html`<span class="pill ${tone}">${label}</span>`

/** Icono de FontAwesome. Si la fuente no carga, el icono просто ocupa espacio. */
export const icon = (name: string, extraClass = ''): Raw => html`<i class="fa-solid fa-${name} ${extraClass}" aria-hidden="true"></i>`

export const CONTRACT_STATUS_TONE: Record<string, Tone> = {
	ACTIVO: 'ok', CORTADO: 'warn', CORTESIA: 'info', RETIRADO: 'mute', RECHAZADO: 'mute', ANULADO: 'mute',
	status_unrecognized: 'bad',
}

interface NavItem {
	readonly href: string
	readonly label: string
	readonly icon: string
}

const NAV: readonly NavItem[] = [
	{ href: '/', label: 'Resumen', icon: 'gauge-high' },
	{ href: '/clientes', label: 'Clientes', icon: 'users' },
	{ href: '/sincronizacion', label: 'Sincronizacion', icon: 'arrows-rotate' },
	{ href: '/configuracion', label: 'Configuracion', icon: 'sliders' },
]

export function layout(input: { title: string; active: string; body: Raw; flash?: { tone: Tone; text: string; html?: Raw } | undefined; company: string }): string {
	const nav = NAV.map(item => `<a href="${item.href}"${input.active === item.href ? ' aria-current="page"' : ''} title="${esc(item.label)}">
		<i class="fa-solid fa-${item.icon} nav-icon" aria-hidden="true"></i><span class="nav-label">${item.label}</span></a>`).join('')

	return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.title)} · Cobrix</title>
<link rel="stylesheet" href="/assets/fontawesome/fontawesome.css">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div class="shell" id="shell">
	<aside class="side" id="sidebar">
		<div class="side-top">
			<div class="brand"><span class="mark">C</span><div class="brand-text"><strong>Cobrix</strong><small>Facturacion de ISP</small></div></div>
			<button class="side-toggle" id="sideToggle" type="button" aria-expanded="true" aria-controls="sidebar" title="Ocultar el menu">
				<i class="fa-solid fa-angles-left" aria-hidden="true"></i>
			</button>
		</div>
		<nav aria-label="Secciones">${nav}</nav>
		<div class="side-foot">${esc(input.company)}</div>
	</aside>
	<div class="backdrop" id="backdrop" hidden></div>
	<div class="content">
		<button class="menu-open" id="menuOpen" type="button" title="Mostrar el menu" aria-label="Mostrar el menu">
			<i class="fa-solid fa-bars" aria-hidden="true"></i>
		</button>
		<main class="main">
			${input.flash ? `<div class="flash ${input.flash.tone}" role="status">${input.flash.html ? input.flash.html.html : esc(input.flash.text)}</div>` : ''}
			${input.body.html}
		</main>
	</div>
</div>
<script>
(function () {
	var shell = document.getElementById('shell');
	var toggle = document.getElementById('sideToggle');
	var open = document.getElementById('menuOpen');
	var backdrop = document.getElementById('backdrop');
	var guardado = null;
	try { guardado = localStorage.getItem('cobrix.sidebar'); } catch (e) { guardado = null; }
	var angosto = window.matchMedia('(max-width: 860px)');
	function escritorio() { return !angosto.matches; }
	function colapsar() { shell.classList.add('collapsed'); toggle.setAttribute('aria-expanded', 'false'); toggle.title = 'Mostrar el menu'; }
	function expandir() { shell.classList.remove('collapsed'); toggle.setAttribute('aria-expanded', 'true'); toggle.title = 'Ocultar el menu'; }
	function aplicarMovil(abierta) { shell.classList.toggle('drawer-open', abierta); backdrop.hidden = !abierta; }
	if (guardado === 'collapsed' && escritorio()) colapsar();
	toggle.addEventListener('click', function () {
		if (escritorio()) {
			var col = shell.classList.toggle('collapsed');
			try { localStorage.setItem('cobrix.sidebar', col ? 'collapsed' : 'expanded'); } catch (e) {}
			toggle.setAttribute('aria-expanded', String(!col));
			toggle.title = col ? 'Mostrar el menu' : 'Ocultar el menu';
		} else { aplicarMovil(false); }
	});
	open.addEventListener('click', function () { aplicarMovil(true); });
	backdrop.addEventListener('click', function () { aplicarMovil(false); });
	document.addEventListener('keydown', function (e) {
		if (e.key === 'Escape') aplicarMovil(false);
	});
	angosto.addEventListener('change', function () {
		if (escritorio()) aplicarMovil(false);
	});
})();
</script>
</body>
</html>`
}

export const CSS = `
:root {
	--bg: #f8f9fb; --surface: #ffffff; --sunken: #f1f3f7; --fg: #1e2933; --muted: #5a6773; --line: #e6e9ee;
	--primary: #5b7fa8; --primary-strong: #4a6c93; --primary-soft: #eaf0f6; --primary-fg: #ffffff;
	--ok: #3f8f6b; --ok-bg: #e6f2eb; --warn: #9a7420; --warn-bg: #f8f0dc;
	--bad: #b4574e; --bad-bg: #f8e7e5; --info: #5b7fa8; --info-bg: #eaf0f6; --mute: #5a6773; --mute-bg: #eef1f5;
	--shadow: 0 1px 2px rgba(30, 41, 51, .05);
	--radius: 8px;
	--font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
	--mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
	color-scheme: light;
}
@media (prefers-color-scheme: dark) { :root {
	--bg: #12161c; --surface: #181e26; --sunken: #1f2630; --fg: #e7ecf2; --muted: #96a1ae; --line: #29313d;
	--primary: #9db6d4; --primary-strong: #b6c9e0; --primary-soft: #1e2833; --primary-fg: #0f141a;
	--ok: #7fc4a3; --ok-bg: #182b23; --warn: #d8bd7e; --warn-bg: #2c2515;
	--bad: #e29a90; --bad-bg: #2e1c1a; --info: #9db6d4; --info-bg: #1e2833; --mute: #96a1ae; --mute-bg: #232b35;
	--shadow: none;
	color-scheme: dark;
} }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.55 var(--font); -webkit-font-smoothing: antialiased; }
a { color: var(--primary-strong); text-decoration: none; }
a:hover { text-decoration: underline; }

/* ---------- estructura y barra lateral ---------- */
.shell { display: grid; grid-template-columns: 232px minmax(0, 1fr); min-height: 100vh; }
.shell.collapsed { grid-template-columns: 64px minmax(0, 1fr); }
.shell.collapsed .brand-text, .shell.collapsed .nav-label, .shell.collapsed .side-foot { display: none; }
.shell.collapsed .side nav a { justify-content: center; padding: 10px 0; }
.shell.collapsed .side-toggle i { transform: rotate(180deg); }
.side { background: var(--surface); border-right: 1px solid var(--line); padding: 14px 10px; display: flex; flex-direction: column; gap: 16px; position: sticky; top: 0; height: 100vh; transition: none; }
.side-top { display: flex; align-items: center; gap: 8px; justify-content: space-between; padding: 0 4px; }
.brand { display: flex; gap: 10px; align-items: center; min-width: 0; }
.brand small { display: block; color: var(--muted); font-size: 11.5px; }
.mark { width: 30px; height: 30px; border-radius: var(--radius); background: var(--primary); color: var(--primary-fg); display: grid; place-items: center; font-weight: 700; flex: none; }
.side-toggle { border: 1px solid transparent; background: transparent; color: var(--muted); border-radius: 6px; padding: 6px 8px; cursor: pointer; }
.side-toggle:hover { background: var(--sunken); color: var(--fg); }
.side nav { display: grid; gap: 2px; }
.side nav a { color: var(--fg); padding: 9px 10px; border-radius: 6px; font-weight: 500; display: flex; align-items: center; gap: 10px; }
.side nav a:hover { background: var(--sunken); text-decoration: none; }
.side nav a[aria-current="page"] { background: var(--primary-soft); color: var(--primary-strong); }
.nav-icon { width: 18px; text-align: center; font-size: 14px; flex: none; }
.side-foot { margin-top: auto; color: var(--muted); font-size: 11.5px; padding: 0 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.backdrop { position: fixed; inset: 0; background: rgba(15, 20, 26, .45); z-index: 20; border: 0; }
.menu-open { display: none; position: fixed; top: 12px; left: 12px; z-index: 5; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 8px 11px; cursor: pointer; color: var(--fg); }
.content { min-width: 0; }
.main { padding: 26px 30px 64px; display: grid; gap: 20px; align-content: start; max-width: 1320px; margin: 0 auto; }

/* ---------- tipografia ---------- */
h1 { font-size: 21px; margin: 0; letter-spacing: -.01em; }
h2 { font-size: 15px; margin: 0; }
h3 { font-size: 14px; margin: 0; }
.head { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; justify-content: space-between; }
.head p { margin: 4px 0 0; color: var(--muted); max-width: 80ch; font-size: 13px; }

/* ---------- tarjetas ---------- */
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); min-width: 0; box-shadow: var(--shadow); }
.card > header { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--line); }
.card > .body { padding: 16px; display: grid; gap: 14px; }
.card > header h2 { display: flex; align-items: center; gap: 8px; }
.card > header h2 i { color: var(--muted); font-size: 13px; font-weight: 400; }

/* ---------- tiles ---------- */
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(168px, 1fr)); gap: 12px; }
.tile { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 13px 15px; display: grid; gap: 3px; }
.tile span { color: var(--muted); font-size: 12px; display: flex; align-items: center; gap: 6px; }
.tile strong { font-size: 19px; font-variant-numeric: tabular-nums; font-weight: 600; }
a.tile { color: inherit; }
a.tile:hover { border-color: var(--primary); text-decoration: none; }
.tile.featured { background: var(--primary-soft); border-color: transparent; }

/* ---------- tablas ---------- */
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 11px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; background: var(--surface); white-space: nowrap; position: sticky; top: 0; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: var(--sunken); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.dinero { font-weight: 600; }
.mono { font-family: var(--mono); font-size: 12.5px; }
.muted { color: var(--muted); }
.empty-row td { color: var(--muted); padding: 18px 12px; text-align: center; }
.empty { border: 1px dashed var(--line); border-radius: var(--radius); padding: 16px 18px; color: var(--muted); background: var(--sunken); }
.empty h3 { margin: 0 0 4px; color: var(--fg); display: flex; align-items: center; gap: 8px; }
.empty p { margin: 0; }

/* ---------- pestanas ---------- */
.pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 500; white-space: nowrap; border: 1px solid transparent; }
.pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
.pill.ok { color: var(--ok); background: var(--ok-bg); } .pill.warn { color: var(--warn); background: var(--warn-bg); }
.pill.bad { color: var(--bad); background: var(--bad-bg); } .pill.info { color: var(--info); background: var(--info-bg); }
.pill.mute { color: var(--mute); background: var(--mute-bg); }

/* ---------- botones y formularios ---------- */
.btn { font: 500 13.5px var(--font); border: 1px solid var(--line); background: var(--surface); color: var(--fg); padding: 8px 14px; border-radius: 7px; cursor: pointer; display: inline-flex; align-items: center; gap: 7px; }
.btn:hover { background: var(--sunken); text-decoration: none; }
.btn.primary { background: var(--primary); border-color: var(--primary); color: var(--primary-fg); }
.btn.primary:hover { background: var(--primary-strong); }
.btn.small { padding: 4px 10px; font-size: 12.5px; }
.btn:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, button:focus-visible, .side-toggle:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.acciones { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.search { display: flex; gap: 8px; max-width: 460px; }
.search input { flex: 1; }
fieldset { border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; margin: 0; }
fieldset legend { font-weight: 600; font-size: 12px; padding: 0 6px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
label.field { display: grid; gap: 5px; font-weight: 500; font-size: 12.5px; color: var(--muted); }
label.field small { font-weight: 400; color: var(--muted); font-size: 11.5px; }
label.check { display: inline-flex; gap: 7px; align-items: center; font-size: 13.5px; font-weight: 400; color: var(--fg); cursor: pointer; }
input[type=text], input[type=password], input[type=number], input[type=search], input[type=time], input[type=url], select {
	font: 14px var(--font); padding: 8px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); color: var(--fg); width: 100%; }
input[type=checkbox] { accent-color: var(--primary); width: 15px; height: 15px; }
dl.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 7px 18px; margin: 0; font-size: 13.5px; }
dl.facts dt { color: var(--muted); }
dl.facts dd { margin: 0; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px 20px; }

/* ---------- avisos y notas ---------- */
.flash { padding: 11px 14px; border-radius: var(--radius); font-weight: 500; font-size: 13.5px; display: flex; gap: 9px; align-items: flex-start; border: 1px solid transparent; }
.flash::before { font-family: "Font Awesome 6 Free"; font-weight: 900; flex: none; }
.flash.ok { background: var(--ok-bg); color: var(--ok); } .flash.ok::before { content: "\\f058"; }
.flash.bad { background: var(--bad-bg); color: var(--bad); } .flash.bad::before { content: "\\f071"; }
.flash.info { background: var(--info-bg); color: var(--info); } .flash.info::before { content: "\\f05a"; }
.flash.warn { background: var(--warn-bg); color: var(--warn); } .flash.warn::before { content: "\\f071"; }
.nota { background: var(--sunken); border-radius: var(--radius); padding: 11px 14px; color: var(--muted); font-size: 12.5px; display: flex; gap: 8px; }
.nota i { color: var(--primary); margin-top: 2px; }

/* ---------- leyendas ---------- */
.leyenda { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; font-size: 12.5px; color: var(--muted); }
.leyenda .pill { cursor: default; }
.leyenda-item { display: inline-flex; align-items: center; gap: 7px; }
.leyenda-item i { font-size: 12px; }

/* ---------- paginacion ---------- */
.paginacion { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; padding: 11px 16px; border-top: 1px solid var(--line); }
.paginacion .info { color: var(--muted); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.paginas { display: flex; gap: 4px; align-items: center; }
.paginas a, .paginas span { min-width: 30px; height: 30px; padding: 0 8px; border: 1px solid var(--line); border-radius: 6px; display: inline-grid; place-items: center; font-size: 12.5px; color: var(--fg); background: var(--surface); font-variant-numeric: tabular-nums; }
.paginas a:hover { background: var(--sunken); text-decoration: none; }
.paginas .activa { background: var(--primary); border-color: var(--primary); color: var(--primary-fg); font-weight: 600; }
.paginas .salto { border: 0; background: transparent; color: var(--muted); }
.paginas .disabled { opacity: .45; pointer-events: none; }
.tamano { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--muted); }
.tamano select { width: auto; padding: 5px 8px; font-size: 12.5px; }

/* ---------- linea de tiempo ---------- */
.timeline { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.timeline li { display: grid; grid-template-columns: 168px minmax(0, 1fr); gap: 12px; align-items: baseline; font-size: 13.5px; }
.timeline time { color: var(--muted); font-size: 12.5px; }

/* ---------- responsive ---------- */
@media (max-width: 860px) {
	.shell, .shell.collapsed { grid-template-columns: minmax(0, 1fr); }
	.side { position: fixed; z-index: 30; top: 0; bottom: 0; left: 0; width: 248px; transform: translateX(-100%); transition: transform .18s ease; box-shadow: 0 10px 30px rgba(15, 20, 26, .18); }
	.shell.drawer-open .side { transform: translateX(0); }
	.shell.drawer-open .backdrop { display: block; }
	.shell.collapsed .brand-text, .shell.collapsed .nav-label, .shell.collapsed .side-foot { display: block; }
	.shell.collapsed .side nav a { justify-content: flex-start; padding: 9px 10px; }
	.side-toggle { display: none; }
	.menu-open { display: inline-flex; }
	.main { padding: 58px 16px 48px; }
	.timeline li { grid-template-columns: minmax(0, 1fr); gap: 2px; }
	.paginacion { flex-direction: column; align-items: flex-start; }
}
`
