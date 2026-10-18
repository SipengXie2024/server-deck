// Review page for a video deck: play the mp4, click a point or drag a box on the picture to comment on that moment.
// Mirrors viewer.js (drafts in localStorage, copy as prompt, send, latest version only).
import { clock, formatComments, locate, videoTarget } from "./prompt.mjs";

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
const video = $("video");
// A comment's pin shows on the picture from just before its time until PIN_HOLD seconds after.
const PIN_HOLD = 3;
// Where a comment without a point (key C) pins, clear of the content.
const WHOLE = [0.97, 0.05];
// Jumping to a scene lands past its fade-in (assemble.py fades each scene from black over 0.4 s).
const LEAD = 0.5;
// A drag shorter than this (fraction of the picture) counts as a click on a point.
const MIN_DRAG = 0.015;

const S = {
	versions: [],
	decks: new Map(), // version -> deck.json
	v: 0,
	comments: [],
	drafts: JSON.parse(localStorage.getItem(draftsKey) || "[]"),
	target: null, // { t, at, box } while the composer is open; box is [x, y, w, h] in 0..1, or null for a point
	scene: null, // name of the scene under the playhead, to re-render only when it changes
	beat: null,
};

const deck = () => S.decks.get(S.v);
const saveDrafts = () => localStorage.setItem(draftsKey, JSON.stringify(S.drafts));
const ofVersion = (c) => c.version === S.v;
const versionDrafts = () => S.drafts.filter(ofVersion);
const isLatest = () => S.v === S.versions.at(-1).version;
const now = () => video.currentTime || 0;
// Drafts store only t; the scene and line are looked up from the version they were written on.
const withTarget = (c) => (c.scene !== undefined ? c : { ...c, ...videoTarget(S.decks.get(c.version) ?? deck(), c.t) });
const visible = () => [...versionDrafts().map((c) => withTarget({ ...c, draft: true })), ...S.comments.filter(ofVersion)].sort((a, b) => a.t - b.t);

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

// ---- hash: #v<version>/t<seconds> ----
function readHash() {
	const m = /^#v(\d+)\/t([\d.]+)$/.exec(location.hash);
	return m ? { v: Number(m[1]), t: Number(m[2]) } : null;
}
function writeHash() {
	history.replaceState(null, "", `#v${S.v}/t${now().toFixed(1)}`);
}

function where(c) {
	if (!c.scene) return clock(c.t);
	return [clock(c.t), c.scene.name, c.beat?.id].filter(Boolean).join(" · ");
}

// ---- render ----
function renderHeader() {
	$("deck-name").textContent = name;
	document.title = `${name} · v${S.v}`;
	$("version").replaceChildren(
		...S.versions.map((v) =>
			el("option", { value: v.version, selected: v.version === S.v }, `v${v.version} · ${new Date(v.publishedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}${v.version > 1 ? ` · 改 ${v.changed.length} 个场景` : ""}`),
		),
	);
	const dl = $("download");
	dl.href = api(`v/${S.v}/video.mp4?download`);
	dl.title = `下载 v${S.v} 的视频（${deck().file}）`;
	const open = S.comments.filter((c) => c.status === "open" && ofVersion(c)).length;
	$("open-count").textContent = open ? `${open} 条待 Claude 处理` : "";
}

function renderScenes() {
	const d = deck();
	if (!d.scenes.length) {
		$("scenes").replaceChildren(el("p", { class: "muted empty" }, "这个视频发布时没有 timeline，批注只记时间点。"));
		return;
	}
	const changed = new Set(d.changed);
	const all = visible();
	const cur = locate(d, now());
	$("scenes").replaceChildren(
		...d.scenes.map((s) => {
			const on = cur.scene === s;
			const n = all.filter((c) => c.scene?.name === s.name).length;
			return el(
				"div",
				{ class: `scene${on ? " on" : ""}` },
				el(
					"button",
					{ class: "thumb", title: `${s.name}${changed.has(s.n) ? "（本版有变化）" : ""}`, onclick: () => seek(s.start + LEAD) },
					el("img", { src: api(`v/${S.v}/${s.thumb}`), loading: "lazy", alt: "" }),
					el("span", { class: "num" }, `${clock(s.start)} ${s.name}`),
					changed.has(s.n) ? el("span", { class: "chg" }) : null,
					n ? el("span", { class: "cnt" }, String(n)) : null,
				),
				on && s.beats.length
					? el(
							"ol",
							{ class: "beats" },
							s.beats.map((b) =>
								el("li", { class: `${cur.beat === b ? "on" : ""}${b.start == null ? " untimed" : ""}`, title: b.text, onclick: b.start != null ? () => seek(Math.max(b.start + 0.05, s.start + LEAD)) : null }, el("b", {}, b.id), " ", b.text),
							),
						)
					: null,
			);
		}),
	);
	$("scenes").querySelector(".scene.on")?.scrollIntoView({ block: "nearest" });
}

function renderTrack() {
	const d = deck();
	const pct = (t) => `${(t / d.duration) * 100}%`;
	const changed = new Set(d.changed);
	const track = $("track");
	track.replaceChildren(
		...d.scenes.map((s) => el("div", { class: `seg${changed.has(s.n) ? " chg" : ""}`, style: `left:${pct(s.start)};width:${pct(s.end - s.start)}`, title: s.name }, el("span", {}, s.name))),
		...visible().map((c) => el("span", { class: `mark ${c.draft ? "draft" : c.status}`, style: `left:${pct(c.t)}`, title: `${clock(c.t)} ${c.body}` })),
		el("div", { class: "head", id: "head", style: `left:${pct(now())}` }),
	);
}

function renderPins() {
	const t = now();
	const pos = (at) => `left:${(at ?? WHOLE)[0] * 100}%;top:${(at ?? WHOLE)[1] * 100}%`;
	// A box comment draws its box, with the pin on the box's top-left corner.
	const mark = (c, cls, label) => [
		c.box ? el("div", { class: `rbox ${cls}`, style: `left:${c.box[0] * 100}%;top:${c.box[1] * 100}%;width:${c.box[2] * 100}%;height:${c.box[3] * 100}%` }) : null,
		el("span", { class: `pin ${cls}`, style: pos(c.box ?? c.at), title: c.body ?? "" }, label),
	];
	const pins = visible()
		.map((c, i) => [c, i])
		.filter(([c]) => t >= c.t - 0.25 && t <= c.t + PIN_HOLD)
		.flatMap(([c, i]) => mark(c, c.draft ? (c.copied ? "draft copied" : "draft") : c.status, String(i + 1)));
	if (S.target) pins.push(...mark(S.target, "new", "+"));
	$("pins").replaceChildren(...pins.filter(Boolean));
}

function renderNotes() {
	const d = deck();
	const { scene, beat } = locate(d, now());
	const parts = [];
	if (beat) parts.push(el("h4", {}, `当前旁白 · ${scene.name} · ${beat.id}`), el("div", { class: "text" }, beat.text));
	else if (scene?.beats.length) {
		parts.push(el("h4", {}, `${scene.name} 的旁白${scene.beats.some((b) => b.start != null) ? "" : "（这一版没有每句的时间）"}`));
		parts.push(el("div", { class: "text" }, scene.beats.map((b) => `${b.id}  ${b.text}`).join("\n")));
	} else parts.push(el("h4", {}, scene ? scene.name : "旁白"), el("div", { class: "text muted" }, d.scenes.length ? "这里没有旁白" : "没有 timeline"));
	$("notes").replaceChildren(...parts);
	$("hint").replaceChildren(
		...(isLatest()
			? ["在画面上拖一个框（或点一下）：暂停并在这一刻写批注 · C 不指位置地批注当前时刻 · 空格 播放/暂停 · ←/→ 5 秒 · [ ] 上/下一场景"]
			: [`v${S.v} 是历史版本，只能查看 · `, el("button", { class: "link", onclick: () => switchVersion(S.versions.at(-1).version) }, `回到最新版 v${S.versions.at(-1).version} 写批注`)]),
	);
	$("hit").hidden = !isLatest();
}

function commentItem(c, { showScene }) {
	const status = c.draft ? (c.copied ? "已复制" : "未复制") : { open: "已发，等 Claude", done: `v${c.resolvedIn ?? "下一版"} 已改`, skipped: "未改" }[c.status];
	const meta = [showScene ? where(c) : [clock(c.t), c.beat?.id].filter(Boolean).join(" · "), status].filter(Boolean).join(" · ");
	const actions = [];
	if (c.draft) actions.push(el("button", { class: "link", onclick: (e) => (e.stopPropagation(), removeDraft(c.key)) }, "删除"));
	if (!c.draft && c.status === "open") actions.push(el("button", { class: "link", onclick: (e) => (e.stopPropagation(), withdraw(c.id)) }, "撤回"));
	return el(
		"li",
		{ class: `cm ${c.draft ? "draft" : c.status}`, onclick: () => (video.pause(), seek(c.t)) },
		el("small", {}, meta, ...actions.map((a) => [" · ", a])),
		el("div", { class: "body" }, c.body),
		c.reply ? el("div", { class: "reply" }, `→ ${c.reply}`) : null,
	);
}

function renderSide() {
	const d = deck();
	const { scene } = locate(d, now());
	const all = visible();
	const here = d.scenes.length ? all.filter((c) => c.scene?.name === scene?.name) : all;
	$("scene-label").textContent = d.scenes.length ? (scene?.name ?? "") : "（没有 timeline，列出全部）";
	$("scene-comments").replaceChildren(...(here.length ? here.map((c) => commentItem(c, { showScene: false })) : [el("li", { class: "muted empty" }, "还没有批注")]));
	$("clear").hidden = !all.length;
	$("all-count").textContent = `(${all.length})`;
	$("all-comments").replaceChildren(...all.map((c) => commentItem(c, { showScene: true })));
	const drafts = versionDrafts();
	const n = drafts.length;
	const fresh = drafts.filter((c) => !c.copied).length;
	$("draft-count").textContent = !n ? "还没有批注" : fresh === n ? `${n} 条未复制` : !fresh ? `${n} 条都已复制` : `${fresh} 条新写的未复制 · ${n - fresh} 条已复制过`;
	$("send").disabled = $("copy").disabled = !n;
	$("copy").textContent = !n ? "复制为提示词" : fresh ? `复制 ${fresh} 条新批注` : `再复制一遍全部 ${n} 条`;
	$("send").textContent = n ? `改用发送（${n} 条）` : "改用发送";
}

function render() {
	renderHeader();
	renderScenes();
	renderTrack();
	renderPins();
	renderNotes();
	renderSide();
}

// Called on every timeupdate: move the playhead, and redraw the rest only when the scene or line changes.
function tick() {
	const d = deck();
	const head = $("head");
	if (head) head.style.left = `${(now() / d.duration) * 100}%`;
	renderPins();
	const { scene, beat } = locate(d, now());
	if (scene?.name !== S.scene || beat?.id !== S.beat) {
		S.scene = scene?.name;
		S.beat = beat?.id;
		renderScenes();
		renderNotes();
		renderSide();
	}
}

// ---- actions ----
function seek(t) {
	video.currentTime = Math.min(deck().duration, Math.max(0, t));
}

async function switchVersion(v) {
	const t = now();
	await loadDeck(v);
	S.v = v;
	closeComposer();
	video.src = api(`v/${v}/video.mp4`);
	video.addEventListener("loadedmetadata", () => seek(Math.min(t, deck().duration)), { once: true });
	render();
}

function openComposer(at, box = null) {
	if (!isLatest()) return;
	video.pause();
	S.target = { t: now(), at, box };
	const { scene, beat } = videoTarget(deck(), S.target.t);
	$("composer").hidden = false;
	$("composer-target").textContent = where({ t: S.target.t, scene, beat }) + (box ? " · 框选" : "");
	$("composer-target").title = beat?.text || "";
	renderPins();
	$("composer").scrollIntoView({ block: "nearest" });
	$("composer-body").focus({ preventScroll: true });
}

function closeComposer() {
	S.target = null;
	$("composer").hidden = true;
	$("composer-body").value = "";
	renderPins();
}

function addDraft() {
	const body = $("composer-body").value.trim();
	if (!body || !S.target) return;
	S.drafts.push({ key: crypto.randomUUID(), version: S.v, t: Math.round(S.target.t * 100) / 100, at: S.target.at, box: S.target.box, body });
	saveDrafts();
	closeComposer();
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
		body: JSON.stringify({ version: S.v, comments: drafts.map((d) => ({ t: d.t, at: d.at, box: d.box, body: d.body })) }),
	});
	if (!r.ok) return toast(`发送失败：${r.status} ${await r.text()}`);
	const keys = new Set(drafts.map((d) => d.key));
	S.drafts = S.drafts.filter((d) => !keys.has(d.key));
	saveDrafts();
	await loadState();
	render();
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
	render();
	toast(`已清除 v${S.v} 的批注。`);
}

async function copyPrompt() {
	const d = deck();
	// Copy only what has not been copied yet; once everything is copied, copy it all again.
	const all = versionDrafts();
	const drafts = (all.some((c) => !c.copied) ? all.filter((c) => !c.copied) : all).sort((a, b) => a.t - b.t);
	const text = formatComments({ name, version: d.version, source: d.source, kind: "video", sources: d.sources }, drafts.map(withTarget));
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
	render();
	toast(`已复制 ${drafts.length} 条批注，粘贴给 Claude 即可。`);
}

async function withdraw(id) {
	if (!confirm("撤回这条批注？")) return;
	const r = await fetch(api(`api/comments/${encodeURIComponent(id)}`), { method: "DELETE" });
	if (!r.ok) toast(`撤回失败：${await r.text()}`);
	await loadState();
	render();
}

// ---- wiring ----
// Press and drag to draw a box; a press without a drag is a point.
{
	const hit = $("hit");
	let start = null;
	const pt = (e) => {
		const r = video.getBoundingClientRect();
		return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
	};
	const boxOf = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])];
	hit.addEventListener("pointerdown", (e) => {
		if (e.button !== 0) return;
		start = pt(e);
		hit.setPointerCapture(e.pointerId);
		video.pause();
	});
	hit.addEventListener("pointermove", (e) => {
		if (!start) return;
		const b = boxOf(start, pt(e));
		if (b[2] < MIN_DRAG && b[3] < MIN_DRAG) return;
		S.target = { t: now(), at: null, box: b };
		renderPins();
	});
	hit.addEventListener("pointerup", (e) => {
		if (!start) return;
		const a = start;
		start = null;
		const b = boxOf(a, pt(e));
		if (b[2] < MIN_DRAG && b[3] < MIN_DRAG) openComposer(a);
		else openComposer([b[0] + b[2] / 2, b[1] + b[3] / 2], b.map((x) => Math.round(x * 1000) / 1000));
	});
	hit.addEventListener("pointercancel", () => {
		start = null;
		closeComposer();
	});
}
$("track").addEventListener("click", (e) => {
	const r = $("track").getBoundingClientRect();
	seek(((e.clientX - r.left) / r.width) * deck().duration);
});
video.addEventListener("timeupdate", tick);
video.addEventListener("seeked", () => (tick(), writeHash()));
video.addEventListener("pause", writeHash);
// The composer belongs to one moment; playing on means it no longer matches the picture.
video.addEventListener("play", () => S.target && !$("composer-body").value.trim() && closeComposer());
$("composer").addEventListener("submit", (e) => (e.preventDefault(), addDraft()));
$("composer-cancel").addEventListener("click", closeComposer);
$("composer-body").addEventListener("keydown", (e) => {
	if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) (e.preventDefault(), addDraft());
	if (e.key === "Escape") closeComposer();
});
$("send").addEventListener("click", sendDrafts);
$("copy").addEventListener("click", copyPrompt);
$("clear").addEventListener("click", clearVersion);
$("version").addEventListener("change", (e) => switchVersion(Number(e.target.value)));
document.addEventListener("keydown", (e) => {
	if (e.target.closest("textarea, input, select") || e.ctrlKey || e.metaKey || e.altKey) return;
	const scenes = deck().scenes;
	const i = scenes.indexOf(locate(deck(), now()).scene);
	const keys = {
		" ": () => (video.paused ? video.play() : video.pause()),
		ArrowLeft: () => seek(now() - 5),
		ArrowRight: () => seek(now() + 5),
		"[": () => i >= 0 && seek((now() - scenes[i].start > 2 ? scenes[i] : scenes[Math.max(0, i - 1)]).start + LEAD),
		"]": () => i >= 0 && i + 1 < scenes.length && seek(scenes[i + 1].start + LEAD),
		c: () => openComposer(null),
		Escape: closeComposer,
	};
	if (!keys[e.key]) return;
	e.preventDefault(); // also stops the focused <video> from handling the same key
	keys[e.key]();
});
document.addEventListener("visibilitychange", async () => {
	if (document.visibilityState !== "visible") return;
	const known = S.versions.length;
	await loadState();
	if (S.versions.length !== known) toast(`有新版本 v${S.versions.at(-1).version}，在左上角切换。`);
	renderHeader();
	renderSide();
	renderScenes();
	renderTrack();
});

(async () => {
	await loadState();
	const h = readHash();
	S.v = h && S.versions.some((x) => x.version === h.v) ? h.v : S.versions.at(-1).version;
	await loadDeck(S.v);
	video.src = api(`v/${S.v}/video.mp4`);
	if (h) video.addEventListener("loadedmetadata", () => seek(h.t), { once: true });
	render();
})().catch((e) => {
	document.body.prepend(el("p", { class: "error" }, `加载失败：${e.message}`));
});
