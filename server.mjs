// Viewer pages, rendered slides and the comment API. Listens on loopback only;
// Put it behind a reverse proxy with auth (see deploy/nginx.conf.example).
import { createReadStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clock, videoTarget } from "./lib/prompt.mjs";
import { deckDir, listDecks, NAME_RE, newCommentId, readComments, readDeck, updateComments, versions } from "./lib/store.mjs";

const PORT = Number(process.env.DECK_PORT || 7240);
const HOST = "127.0.0.1";
const BODY_MAX = 1 << 20;
const BODY_LEN_MAX = 4000; // characters in one comment

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const STATIC = {
	"viewer.js": [here("web/viewer.js"), "text/javascript"],
	"video.js": [here("web/video.js"), "text/javascript"],
	"viewer.css": [here("web/viewer.css"), "text/css"],
	"prompt.mjs": [here("lib/prompt.mjs"), "text/javascript"],
};
const TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json", ".mp4": "video/mp4", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
// A published version never changes, so its files can be cached.
const IMMUTABLE = "private, max-age=31536000, immutable";

// Serve a file with HTTP Range support; <video> needs 206 responses to seek.
async function sendFile(req, res, p, headers) {
	const size = (await stat(p)).size;
	const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
	if (!m || (!m[1] && !m[2])) {
		res.writeHead(200, { "Content-Length": size, "Accept-Ranges": "bytes", ...headers });
		return createReadStream(p).pipe(res);
	}
	// "bytes=-N" is the last N bytes.
	let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
	let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
	if (start >= size || start > end) {
		res.writeHead(416, { "Content-Range": `bytes */${size}` });
		return res.end();
	}
	res.writeHead(206, { "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", ...headers });
	return createReadStream(p, { start, end }).pipe(res);
}

function send(res, code, body, type = "text/plain; charset=utf-8", extra = {}) {
	res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
	res.end(body);
}
const json = (res, code, value) => send(res, code, JSON.stringify(value), "application/json; charset=utf-8");

async function readBody(req) {
	let size = 0;
	const chunks = [];
	for await (const c of req) {
		size += c.length;
		if (size > BODY_MAX) throw Object.assign(new Error("body too large"), { code: 413 });
		chunks.push(c);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function indexPage() {
	const rows = [];
	for (const name of await listDecks()) {
		const v = (await versions(name)).at(-1);
		if (!v) continue;
		const deck = await readDeck(name, v);
		const open = (await readComments(name)).filter((c) => c.status === "open").length;
		const size = deck.kind === "video" ? `视频 ${clock(deck.duration)}` : `${deck.slides.length} 页`;
		rows.push(`<li><a href="${escapeHtml(name)}/">${escapeHtml(name)}</a> · v${v} · ${size} · ${escapeHtml(deck.publishedAt.slice(0, 16).replace("T", " "))} UTC${open ? ` · <b>${open} 条待处理</b>` : ""}</li>`);
	}
	return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Decks</title><link rel="stylesheet" href="_static/viewer.css"><body class="index"><h1>Decks</h1><ul>${rows.join("") || "<li>还没有发布过 deck</li>"}</ul></body>`;
}

function cleanComment(c, deck) {
	const body = String(c.body ?? "").trim();
	if (!body || body.length > BODY_LEN_MAX) throw new Error("comment body is empty or too long");
	const at = Array.isArray(c.at) && c.at.length === 2 ? c.at.map((x) => Math.min(1, Math.max(0, Number(x) || 0))) : null;
	if (deck.kind === "video") {
		const t = Number(c.t);
		if (!Number.isFinite(t) || t < 0 || t > deck.duration + 0.5) throw new Error(`no time ${c.t} in the video`);
		// As with shapes, the scene and line come from deck.json rather than the client.
		// box: [x, y, w, h] as fractions of the picture, kept inside it.
		let box = null;
		if (Array.isArray(c.box) && c.box.length === 4) {
			const [x, y, w, h] = c.box.map((v) => Math.min(1, Math.max(0, Number(v) || 0)));
			if (w > 0 && h > 0) box = [x, y, Math.min(w, 1 - x), Math.min(h, 1 - y)].map((v) => Math.round(v * 1000) / 1000);
		}
		return { t: Math.round(t * 100) / 100, at, box, ...videoTarget(deck, t), body };
	}
	const slide = deck.slides[Number(c.slide) - 1];
	if (!slide) throw new Error(`no slide ${c.slide}`);
	// Take the shape from deck.json, not from the client, so the prompt quotes the real text.
	const shape = c.shapeId == null ? null : slide.shapes.find((s) => s.id === Number(c.shapeId));
	if (c.shapeId != null && !shape) throw new Error(`no shape ${c.shapeId} on slide ${c.slide}`);
	return { slide: slide.n, shape: shape && { id: shape.id, name: shape.name, text: shape.text }, at: at ?? [0.5, 0.5], body };
}

async function handle(req, res) {
	const url = new URL(req.url, "http://x");
	const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

	if (parts.length === 0) return send(res, 200, await indexPage(), "text/html; charset=utf-8");
	if (parts[0] === "_static" && parts.length === 2 && STATIC[parts[1]]) {
		const [file, type] = STATIC[parts[1]];
		return send(res, 200, await readFile(file), `${type}; charset=utf-8`);
	}

	const name = parts[0];
	if (!NAME_RE.test(name) || name.startsWith(".") || !existsSync(deckDir(name))) return send(res, 404, "no such deck");
	if (parts.length === 1 && !url.pathname.endsWith("/")) {
		// Relative, so it stays under /deck/ behind nginx.
		return send(res, 301, "", "text/plain", { Location: `${name}/` });
	}

	const rest = parts.slice(1);
	if (rest.length === 0 || (rest.length === 1 && rest[0] === "index.html")) {
		const v = (await versions(name)).at(-1);
		const page = v && (await readDeck(name, v)).kind === "video" ? "web/video.html" : "web/viewer.html";
		return send(res, 200, await readFile(here(page)), "text/html; charset=utf-8");
	}

	if (rest[0] === "v" && rest.length === 3) {
		const [, v, file] = rest;
		if (!/^\d+$/.test(v) || !/^(deck\.json|deck\.pptx|video\.mp4|[st]-\d{3}\.(png|jpg))$/.test(file)) return send(res, 404, "not found");
		const p = path.join(deckDir(name), `v${v}`, file);
		if (!existsSync(p)) return send(res, 404, "not found");
		if (file === "deck.pptx") {
			// Download under the original file name, tagged with the version.
			const orig = (await readDeck(name, v)).file || `${name}.pptx`;
			const dl = orig.replace(/(\.pptx)?$/i, `-v${v}.pptx`);
			res.writeHead(200, {
				"Content-Type": TYPES[".pptx"],
				"Content-Disposition": `attachment; filename="${name}-v${v}.pptx"; filename*=UTF-8''${encodeURIComponent(dl)}`,
				"Cache-Control": IMMUTABLE,
			});
			return createReadStream(p).pipe(res);
		}
		const headers = { "Content-Type": TYPES[path.extname(file)], "Cache-Control": IMMUTABLE };
		if (file === "video.mp4" && url.searchParams.has("download")) {
			const dl = ((await readDeck(name, v)).file || `${name}.mp4`).replace(/(\.[^.]+)?$/, (ext) => `-v${v}${ext || ".mp4"}`);
			headers["Content-Disposition"] = `attachment; filename="${name}-v${v}.mp4"; filename*=UTF-8''${encodeURIComponent(dl)}`;
		}
		return sendFile(req, res, p, headers);
	}

	if (rest[0] === "api" && rest[1] === "state" && req.method === "GET") {
		const vs = await versions(name);
		const decks = await Promise.all(vs.map((v) => readDeck(name, v)));
		return json(res, 200, {
			name,
			versions: decks.map((d) => ({ version: d.version, publishedAt: d.publishedAt, changed: d.changed, ...(d.kind === "video" ? { duration: d.duration } : { slides: d.slides.length }) })),
			comments: await readComments(name),
		});
	}

	if (rest[0] === "api" && rest[1] === "comments" && rest.length === 2 && req.method === "POST") {
		// A JSON content type forces a CORS preflight, so other sites cannot post with the user's login.
		if (!/^application\/json\b/.test(req.headers["content-type"] || "")) return send(res, 415, "expected application/json");
		const body = await readBody(req);
		const v = Number(body.version);
		if (!(await versions(name)).includes(v)) return send(res, 400, `no version ${body.version}`);
		const deck = await readDeck(name, v);
		const incoming = Array.isArray(body.comments) ? body.comments : [];
		if (!incoming.length || incoming.length > 200) return send(res, 400, "expected 1 to 200 comments");
		let cleaned;
		try {
			cleaned = incoming.map((c) => cleanComment(c, deck));
		} catch (e) {
			return send(res, 400, e.message);
		}
		const author = String(req.headers["x-remote-user"] || "local");
		const saved = await updateComments(name, (comments) => {
			const taken = new Set(comments.map((c) => c.id));
			const added = cleaned.map((c) => {
				const id = newCommentId(taken);
				taken.add(id);
				return { id, version: v, ...c, author, createdAt: new Date().toISOString(), status: "open" };
			});
			comments.push(...added);
			return added;
		});
		return json(res, 200, { comments: saved });
	}

	if (rest[0] === "api" && rest[1] === "comments" && rest.length === 2 && req.method === "DELETE") {
		// Clear every comment written on one version, resolved or not.
		const v = Number(url.searchParams.get("version"));
		if (!(await versions(name)).includes(v)) return send(res, 400, `no version ${url.searchParams.get("version")}`);
		const removed = await updateComments(name, (comments) => {
			const keep = comments.filter((c) => c.version !== v);
			const n = comments.length - keep.length;
			comments.splice(0, comments.length, ...keep);
			return n;
		});
		return json(res, 200, { removed });
	}

	if (rest[0] === "api" && rest[1] === "comments" && rest.length === 3 && req.method === "DELETE") {
		const id = rest[2];
		const result = await updateComments(name, (comments) => {
			const i = comments.findIndex((c) => c.id === id);
			if (i < 0) return "missing";
			if (comments[i].status !== "open") return "resolved";
			comments.splice(i, 1);
			return "ok";
		});
		if (result === "missing") return send(res, 404, "no such comment");
		if (result === "resolved") return send(res, 409, "已处理的批注不能撤回");
		return json(res, 200, { ok: true });
	}

	return send(res, 404, "not found");
}

http
	.createServer((req, res) => {
		handle(req, res).catch((e) => {
			console.error(e);
			if (!res.headersSent) send(res, e.code === 413 ? 413 : e instanceof SyntaxError ? 400 : 500, e.message);
			else res.end();
		});
	})
	.listen(PORT, HOST, () => console.log(`server-deck on http://${HOST}:${PORT}/`));
