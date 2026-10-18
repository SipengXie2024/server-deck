import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { missingFonts } from "./fonts.mjs";
import { openPptx } from "./pptx.mjs";
import { render } from "./render.mjs";
import { extractShapes } from "./shapes.mjs";
import { deckDir, readDeck, updateComments, versions, writeJson } from "./store.mjs";
import { publishVideo } from "./video.mjs";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

// A slide counts as changed when its image or its speaker notes change.
// Slides without notes hash the image alone, matching versions published before notes were read.
export const slideHash = (png, notes) => (notes ? createHash("sha256").update(png).update("\0").update(notes).digest("hex") : sha(png)).slice(0, 16);

export class MissingFontsError extends Error {
	constructor(fonts) {
		super(`缺字体：${fonts.join("、")}`);
		this.fonts = fonts;
	}
}

export const isVideo = (file) => /\.(mp4|m4v|mov|webm)$/i.test(file);

// Returns { deck, unchanged } where unchanged means the bytes match the latest version.
// A video goes to publishVideo; opts.timeline overrides the <video>.timeline.json beside it.
export async function publish(file, name, log = () => {}, opts = {}) {
	const source = path.resolve(file);
	const bytes = await readFile(source);
	if (isVideo(source)) return publishVideo(source, bytes, sha(bytes), name, opts, log);
	const pptxSha = sha(bytes);
	const dir = deckDir(name);
	const have = await versions(name);
	const prev = have.length ? await readDeck(name, have.at(-1)) : null;
	if (prev?.kind === "video") throw new Error(`${name} 是视频，pptx 换个名字发布`);
	if (prev && prev.pptxSha === pptxSha) return { deck: prev, unchanged: true };

	const pptx = await openPptx(source);
	const missing = missingFonts(pptx);
	if (missing.length) throw new MissingFontsError(missing);

	const version = (have.at(-1) ?? 0) + 1;
	const tmp = path.join(dir, `.v${version}.tmp`);
	await rm(tmp, { recursive: true, force: true });
	await mkdir(tmp, { recursive: true });
	try {
		const t0 = Date.now();
		const images = await render(source, tmp, pptx.slides.length);
		log(`render  ${images.length} 页  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
		const shapes = extractShapes(pptx);

		// A slide is unchanged if the same image and notes exist in the previous version;
		// matching by image rather than position survives inserted or moved slides.
		const prevByHash = new Map((prev?.slides ?? []).map((s) => [s.hash, s.n]));
		const slides = [];
		for (let i = 0; i < images.length; i++) {
			const hash = slideHash(await readFile(path.join(tmp, images[i].png)), pptx.slides[i].notes);
			slides.push({ n: i + 1, ...images[i], hash, same: prevByHash.get(hash) ?? null, hidden: pptx.slides[i].hidden, notes: pptx.slides[i].notes, shapes: shapes[i].shapes });
		}
		const changed = prev ? slides.filter((s) => s.same == null).map((s) => s.n) : [];
		const deck = {
			name, version, source, pptxSha,
			file: path.basename(source),
			publishedAt: new Date().toISOString(),
			size: pptx.size,
			changed,
			slides,
		};
		// Keep the exact bytes reviewed, for download; the source file may change later.
		await writeFile(path.join(tmp, "deck.pptx"), bytes);
		await writeJson(path.join(tmp, "deck.json"), deck);
		await rename(tmp, path.join(dir, `v${version}`));

		// Comments resolved since the last publish are now visible in this version.
		await updateComments(name, (comments) => {
			for (const c of comments) if (c.status !== "open" && c.resolvedIn == null) c.resolvedIn = version;
		});
		return { deck, unchanged: false };
	} catch (e) {
		await rm(tmp, { recursive: true, force: true });
		throw e;
	}
}

export async function latest(name) {
	const have = await versions(name);
	if (!have.length) throw new Error(`没有名为 ${name} 的 deck；先 deck publish`);
	return readDeck(name, have.at(-1));
}

export const exists = (name) => existsSync(deckDir(name));
