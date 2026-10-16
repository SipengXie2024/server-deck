import { formatComments } from "./prompt.mjs";

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
	const e = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === "class") e.className = v;
		else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
		else if (v != null && v !== false) e.setAttribute(k, v === true ? "" : v);
	}
	for (const c of children.flat()) if (c != null) e.append(c);
	return e;
};

const name = decodeURIComponent(location.pathname.split("/").filter(Boolean).at(-1));
const api = (p) => `./${p}`;
const draftsKey = `deck:${name}:drafts`;

const S = {
	versions: [],
	decks: new Map(), // version -> deck.json
	v: 0,
	n: 1,
	comments: [],
	drafts: JSON.parse(localStorage.getItem(draftsKey) || "[]"),
	target: null, // { shape, at } while the composer is open
	compare: false,
};

const deck = () => S.decks.get(S.v);
const slide = () => deck().slides[S.n - 1];
const saveDrafts = () => localStorage.setItem(draftsKey, JSON.stringify(S.drafts));
// Comments belong to the version they were written on; the page shows only the current version's.
const ofVersion = (c) => c.version === S.v;
const versionDrafts = () => S.drafts.filter(ofVersion);
// Comments are written only on the latest version; older versions are read-only.
const isLatest = () => S.v === S.versions.at(-1).version;

async function loadDeck(v) {
	if (!S.decks.has(v)) {
		const r = await fetch(api(`v/${v}/deck.json`));
		if (!r.ok) throw new Error(`v${v}: ${r.status}`);
		S.decks.set(v, await r.json());
	}
	return S.decks.get(v);
}

async function loadState() {
	const r = await fetch(api("api/state"), { cache: "no-store" });
	if (!r.ok) throw new Error(`state: ${r.status}`);
	const s = await r.json();
	S.versions = s.versions;
	S.comments = s.comments;
}

// ---- hash: #v<version>/<slide> ----
function readHash() {
	const m = /^#v(\d+)\/(\d+)$/.exec(location.hash);
	return m ? { v: Number(m[1]), n: Number(m[2]) } : null;
}
function writeHash() {
	history.replaceState(null, "", `#v${S.v}/${S.n}`);
}

// ---- geometry ----
const area = (b) => b[2] * b[3];
function hitTest(px, py) {
	const hits = slide().shapes.filter(({ box: [x, y, w, h] }) => px >= x && px <= x + w && py >= y && py <= y + h);
	hits.sort((a, b) => area(a.box) - area(b.box));
	return hits[0] ?? null;
}
function shapeLabel(shape) {
	if (!shape) return "整页";
	const generic = /^(TextBox|Rectangle|Image|Picture|Group|Shape|Text|Oval|Line|Table|Chart|文本框|矩形|图片|组合) ?\d*$/i.test(shape.name);
	const text = shape.text ? `「${shape.text.slice(0, 18)}${shape.text.length > 18 ? "…" : ""}」` : "";
	return generic || !shape.name ? `${shape.name || "#" + shape.id} ${text}`.trim() : shape.name;
}

// ---- render ----
function renderHeader() {
	$("deck-name").textContent = name;
	document.title = `${name} · v${S.v}`;
	const sel = $("version");
	sel.replaceChildren(
		...S.versions.map((v) =>
			el("option", { value: v.version, selected: v.version === S.v }, `v${v.version} · ${new Date(v.publishedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}${v.version > 1 ? ` · 改 ${v.changed.length} 页` : ""}`),
		),
	);
	$("compare-wrap").hidden = S.v <= 1;
	const dl = $("download");
	dl.hidden = !deck().file; // versions published before downloads were kept have no pptx copy
	dl.href = api(`v/${S.v}/deck.pptx`);
	dl.title = `下载 v${S.v} 的原 pptx（${deck().file ?? ""}）`;
	const open = S.comments.filter((c) => c.status === "open" && ofVersion(c)).length;
	$("open-count").textContent = open ? `${open} 条待 Claude 处理` : "";
}

function renderThumbs() {
	const d = deck();
	const changed = new Set(d.changed);
	const count = (n) => S.comments.filter((c) => c.slide === n && c.version === S.v).length + S.drafts.filter((c) => c.slide === n && c.version === S.v).length;
	$("thumbs").replaceChildren(
		...d.slides.map((s) =>
			el(
				"button",
				{ class: `thumb${s.n === S.n ? " on" : ""}${s.hidden ? " hidden-slide" : ""}`, title: `第 ${s.n} 页${changed.has(s.n) ? "（本版有变化）" : ""}`, onclick: () => go(s.n) },
				el("img", { src: api(`v/${S.v}/${s.thumb}`), loading: "lazy", alt: "" }),
				el("span", { class: "num" }, String(s.n)),
				changed.has(s.n) ? el("span", { class: "chg" }) : null,
				count(s.n) ? el("span", { class: "cnt" }, String(count(s.n))) : null,
			),
		),
	);
	$("thumbs").querySelector(".on")?.scrollIntoView({ block: "nearest" });
}

function frame(d, s, { interactive, label }) {
	const img = el("img", { src: api(`v/${d.version}/${s.png}`), alt: `第 ${s.n} 页`, draggable: "false" });
	const box = el("div", { class: "hover-box", hidden: true });
	const pins = el("div", { class: "pins" });
	const commentable = interactive && isLatest();
	const wrap = el("div", { class: `slidebox${commentable ? " interactive" : ""}`, style: `aspect-ratio:${d.size.cx}/${d.size.cy}` }, img, box, pins);
	if (commentable) {
		const pos = (e) => {
			const r = img.getBoundingClientRect();
			return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
		};
		wrap.addEventListener("mousemove", (e) => {
			const shape = hitTest(...pos(e));
			box.hidden = !shape;
			if (shape) {
				const [x, y, w, h] = shape.box;
				Object.assign(box.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
				box.dataset.label = shapeLabel(shape);
			}
		});
		wrap.addEventListener("mouseleave", () => (box.hidden = true));
		wrap.addEventListener("click", (e) => {
			const at = pos(e);
			openComposer(hitTest(...at), at);
		});
	}
	if (interactive) {
		const here = [...S.drafts.map((c) => ({ ...c, draft: true })), ...S.comments].filter((c) => c.version === S.v && c.slide === s.n);
		here.forEach((c, i) => {
			pins.append(el("span", { class: `pin ${c.draft ? (c.copied ? "draft copied" : "draft") : c.status}`, style: `left:${c.at[0] * 100}%;top:${c.at[1] * 100}%`, title: c.body }, String(i + 1)));
		});
		if (S.target) {
			pins.append(el("span", { class: "pin new", style: `left:${S.target.at[0] * 100}%;top:${S.target.at[1] * 100}%` }, "+"));
		}
	}
	return el("figure", {}, label ? el("figcaption", { class: "muted" }, label) : null, wrap);
}

async function renderStage() {
	const d = deck();
	const s = slide();
	const frames = [];
	if (S.compare && S.v > 1) {
		const prev = await loadDeck(S.v - 1);
		const ps = s.same != null ? prev.slides[s.same - 1] : prev.slides[S.n - 1];
		const label = s.same != null ? `v${S.v - 1} 第 ${s.same} 页 · 未变化` : ps ? `v${S.v - 1} 第 ${ps.n} 页` : `v${S.v - 1} 没有这一页`;
		frames.push(ps ? frame(prev, ps, { interactive: false, label }) : el("figure", { class: "empty" }, el("figcaption", { class: "muted" }, label)));
	}
	$("hint").replaceChildren(
		...(isLatest()
			? ["点一个形状写批注 · 点空白处或按 ", el("button", { class: "link", onclick: wholeSlide }, "整页批注"), " · ←/→ 翻页"]
			: [`v${S.v} 是历史版本，只能查看 · `, el("button", { class: "link", onclick: () => goTo(S.versions.at(-1).version, S.n) }, `回到最新版 v${S.versions.at(-1).version} 写批注`)]),
	);
	frames.push(frame(d, s, { interactive: true, label: S.compare && S.v > 1 ? `v${S.v} 第 ${S.n} 页${d.changed.includes(S.n) ? " · 有变化" : ""}` : null }));
	$("frames").replaceChildren(...frames);
	$("frames").classList.toggle("two", frames.length === 2);
	await renderNotes();
}

async function renderNotes() {
	const notes = slide().notes;
	const parts = [el("h4", {}, "备注"), el("div", { class: notes ? "text" : "text muted" }, notes || (notes == null ? "这个版本发布时还没有读取备注" : "本页没有备注"))];
	if (S.compare && S.v > 1) {
		const prev = await loadDeck(S.v - 1);
		const s = slide();
		const ps = s.same != null ? prev.slides[s.same - 1] : prev.slides[S.n - 1];
		if (ps && (ps.notes ?? "") !== (notes ?? "")) parts.push(el("div", { class: "old" }, el("h4", {}, `v${S.v - 1} 的备注`), el("div", { class: "text" }, ps.notes || "（无）")));
	}
	$("notes").replaceChildren(...parts);
}

function commentItem(c, { showSlide }) {
	const status = c.draft ? (c.copied ? "已复制" : "未复制") : { open: "已发，等 Claude", done: `v${c.resolvedIn ?? "下一版"} 已改`, skipped: "未改" }[c.status];
	const meta = [showSlide ? `第 ${c.slide} 页` : null, shapeLabel(c.shape), c.version !== S.v ? `写于 v${c.version}` : null, status].filter(Boolean).join(" · ");
	const actions = [];
	if (c.draft) actions.push(el("button", { class: "link", onclick: (e) => (e.stopPropagation(), removeDraft(c.key)) }, "删除"));
	if (!c.draft && c.status === "open") actions.push(el("button", { class: "link", onclick: (e) => (e.stopPropagation(), withdraw(c.id)) }, "撤回"));
	return el(
		"li",
		{ class: `cm ${c.draft ? "draft" : c.status}`, onclick: showSlide ? () => goTo(c.version, c.slide) : null },
		el("small", {}, meta, ...actions.map((a) => [" · ", a])),
		el("div", { class: "body" }, c.body),
		c.reply ? el("div", { class: "reply" }, `→ ${c.reply}`) : null,
	);
}

function renderSide() {
	$("slide-label").textContent = `第 ${S.n} 页`;
	const drafts = versionDrafts().map((c) => ({ ...c, draft: true }));
	const mine = S.comments.filter(ofVersion);
	const here = [...drafts, ...mine].filter((c) => c.slide === S.n);
	$("slide-comments").replaceChildren(...(here.length ? here.map((c) => commentItem(c, { showSlide: false })) : [el("li", { class: "muted empty" }, "还没有批注")]));
	const all = [...drafts, ...mine].sort((a, b) => a.slide - b.slide);
	$("clear").hidden = !all.length;
	$("all-count").textContent = `(${all.length})`;
	$("all-comments").replaceChildren(...all.map((c) => commentItem(c, { showSlide: true })));
	const n = drafts.length;
	const fresh = drafts.filter((c) => !c.copied).length;
	$("draft-count").textContent = !n ? "还没有批注" : fresh === n ? `${n} 条未复制` : !fresh ? `${n} 条都已复制` : `${fresh} 条新写的未复制 · ${n - fresh} 条已复制过`;
	$("send").disabled = $("copy").disabled = !n;
	$("copy").textContent = !n ? "复制为提示词" : fresh ? `复制 ${fresh} 条新批注` : `再复制一遍全部 ${n} 条`;
	$("send").textContent = n ? `改用发送（${n} 条）` : "改用发送";
}

async function render() {
	renderHeader();
	renderThumbs();
	await renderStage();
	renderSide();
}

// ---- actions ----
async function go(n) {
	const total = deck().slides.length;
	S.n = Math.min(total, Math.max(1, n));
	closeComposer(false);
	writeHash();
	await render();
}

async function goTo(v, n) {
	if (v !== S.v && S.versions.some((x) => x.version === v)) {
		await loadDeck(v);
		S.v = v;
	}
	await go(n);
}

function openComposer(shape, at) {
	S.target = { shape, at };
	$("composer").hidden = false;
	$("composer-target").textContent = `第 ${S.n} 页 · ${shapeLabel(shape)}`;
	$("composer-target").title = shape?.text || "";
	renderStage();
	$("composer").scrollIntoView({ block: "nearest" });
	$("composer-body").focus({ preventScroll: true });
}

function closeComposer(rerender = true) {
	S.target = null;
	$("composer").hidden = true;
	$("composer-body").value = "";
	if (rerender) renderStage();
}

function addDraft() {
	const body = $("composer-body").value.trim();
	if (!body || !S.target) return;
	const { shape, at } = S.target;
	S.drafts.push({
		key: crypto.randomUUID(),
		version: S.v,
		slide: S.n,
		shape: shape && { id: shape.id, name: shape.name, text: shape.text },
		at,
		body,
	});
	saveDrafts();
	closeComposer(false);
	render();
}

function removeDraft(key) {
	S.drafts = S.drafts.filter((d) => d.key !== key);
	saveDrafts();
	render();
}

function toast(msg) {
	$("toast").textContent = msg;
	clearTimeout(toast.t);
	toast.t = setTimeout(() => ($("toast").textContent = ""), 6000);
}

async function sendDrafts() {
	const drafts = versionDrafts();
	if (!drafts.length) return;
	const r = await fetch(api("api/comments"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ version: S.v, comments: drafts.map((d) => ({ slide: d.slide, shapeId: d.shape?.id ?? null, at: d.at, body: d.body })) }),
	});
	if (!r.ok) return toast(`发送失败：${r.status} ${await r.text()}`);
	const keys = new Set(drafts.map((d) => d.key));
	S.drafts = S.drafts.filter((d) => !keys.has(d.key));
	saveDrafts();
	await loadState();
	await render();
	toast(`已发送 ${drafts.length} 条。在 Claude 会话里说「看批注」。`);
}

async function clearVersion() {
	const sent = S.comments.filter(ofVersion).length;
	const drafts = versionDrafts().length;
	if (!confirm(`清除 v${S.v} 的全部批注（已发送 ${sent} 条、未发送 ${drafts} 条）？删除后不能恢复。`)) return;
	if (sent) {
		const r = await fetch(api(`api/comments?version=${S.v}`), { method: "DELETE" });
		if (!r.ok) return toast(`清除失败：${await r.text()}`);
	}
	S.drafts = S.drafts.filter((d) => !ofVersion(d));
	saveDrafts();
	await loadState();
	await render();
	toast(`已清除 v${S.v} 的批注。`);
}

async function copyPrompt() {
	const d = deck();
	// Copy only what has not been copied yet, so a second batch does not repeat the first;
	// once everything is copied, copy it all again.
	const all = versionDrafts();
	const drafts = all.some((c) => !c.copied) ? all.filter((c) => !c.copied) : all;
	const text = formatComments({ name, version: d.version, source: d.source }, drafts);
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		const ta = el("textarea", { style: "position:fixed;opacity:0" }, text);
		document.body.append(ta);
		ta.select();
		document.execCommand("copy");
		ta.remove();
	}
	for (const c of drafts) c.copied = true;
	saveDrafts();
	renderSide();
	renderStage();
	toast(`已复制 ${drafts.length} 条批注，粘贴给 Claude 即可。`);
}

async function withdraw(id) {
	if (!confirm("撤回这条批注？")) return;
	const r = await fetch(api(`api/comments/${encodeURIComponent(id)}`), { method: "DELETE" });
	if (!r.ok) toast(`撤回失败：${await r.text()}`);
	await loadState();
	await render();
}

// ---- wiring ----
$("composer").addEventListener("submit", (e) => (e.preventDefault(), addDraft()));
$("composer-cancel").addEventListener("click", () => closeComposer());
$("composer-body").addEventListener("keydown", (e) => {
	if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) (e.preventDefault(), addDraft());
	if (e.key === "Escape") closeComposer();
});
// Whole-slide comments pin to the top-right corner, clear of the content.
function wholeSlide() {
	if (isLatest()) openComposer(null, [0.97, 0.05]);
}
$("send").addEventListener("click", sendDrafts);
$("copy").addEventListener("click", copyPrompt);
$("clear").addEventListener("click", clearVersion);
$("compare").addEventListener("change", (e) => ((S.compare = e.target.checked), renderStage()));
$("version").addEventListener("change", async (e) => {
	await loadDeck(Number(e.target.value));
	S.v = Number(e.target.value);
	await go(Math.min(S.n, deck().slides.length));
});
document.addEventListener("keydown", (e) => {
	if (e.target.closest("textarea, input, select")) return;
	if (e.key === "ArrowRight" || e.key === "PageDown") go(S.n + 1);
	if (e.key === "ArrowLeft" || e.key === "PageUp") go(S.n - 1);
	if (e.key === "Escape") closeComposer();
});
// Comments change when Claude resolves them; pick that up when the tab comes back.
document.addEventListener("visibilitychange", async () => {
	if (document.visibilityState !== "visible") return;
	const known = S.versions.length;
	await loadState();
	if (S.versions.length !== known) toast(`有新版本 v${S.versions.at(-1).version}，在左上角切换。`);
	renderHeader();
	renderSide();
	renderThumbs();
});

(async () => {
	await loadState();
	const h = readHash();
	const latest = S.versions.at(-1).version;
	S.v = h && S.versions.some((x) => x.version === h.v) ? h.v : latest;
	await loadDeck(S.v);
	S.n = h ? Math.min(Math.max(1, h.n), deck().slides.length) : 1;
	writeHash();
	await render();
})().catch((e) => {
	document.body.prepend(el("p", { class: "error" }, `加载失败：${e.message}`));
});
