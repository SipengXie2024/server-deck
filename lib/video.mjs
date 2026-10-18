// Video decks: an mp4 plus an optional <video>.timeline.json that names its scenes and
// narration lines, so a comment at 03:12 maps back to a line of the script.
//
// timeline.json: { sources: [paths], scenes: [{ name, start, end, beats: [{ id, text, start, end }] }] }
// Times are seconds in the final video; a beat's start/end may be null when only its text is known.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { deckDir, readDeck, updateComments, versions, writeJson } from "./store.mjs";

const run = promisify(execFile);
const ff = (args) => run("ffmpeg", ["-loglevel", "error", "-nostdin", ...args], { maxBuffer: 64 << 20, encoding: "buffer" });

async function probe(file) {
	const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file]);
	const j = JSON.parse(stdout);
	return { duration: Number(j.format.duration), width: j.streams[0].width, height: j.streams[0].height };
}

// One frame at time t, scaled to `width`, as JPEG bytes (or written to `out`); `box` ([x, y, w, h]
// as fractions) is drawn on it as a red rectangle.
export async function grab(file, t, width, out, box) {
	const draw = box ? `,drawbox=x=iw*${box[0]}:y=ih*${box[1]}:w=iw*${box[2]}:h=ih*${box[3]}:color=red@0.9:t=6` : "";
	const args = ["-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", `scale=${width}:-2${draw}`];
	if (out) return ff([...args, "-y", out]);
	return (await ff([...args, "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "4", "-"])).stdout;
}

// Raw pixels of a few small frames, for change detection. Each scene is encoded on its own
// before concatenation, so an unchanged scene decodes to the same pixels wherever it sits.
async function scenePixels(file, s) {
	const h = createHash("sha256");
	for (const f of [0.25, 0.5, 0.75]) {
		const { stdout } = await ff(["-ss", (s.start + (s.end - s.start) * f).toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=96:-2", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
		h.update(stdout);
	}
	return h;
}

function readTimeline(tl, duration) {
	if (!Array.isArray(tl.scenes) || !tl.scenes.length) throw new Error("timeline 里没有 scenes");
	for (const s of tl.scenes) {
		if (typeof s.name !== "string" || !(s.end > s.start)) throw new Error(`timeline 场景格式不对：${JSON.stringify(s).slice(0, 120)}`);
		s.beats ??= [];
	}
	const end = tl.scenes.at(-1).end;
	if (Math.abs(end - duration) > 1) throw new Error(`timeline 总长 ${end.toFixed(1)}s，视频是 ${duration.toFixed(1)}s，对不上（是不是旧的 timeline？）`);
	return { sources: tl.sources ?? [], scenes: tl.scenes };
}

export const timelineFor = (file) => file.replace(/\.[^./]+$/, "") + ".timeline.json";

// Same contract as publish(): returns { deck, unchanged }.
export async function publishVideo(source, bytes, sha, name, { timeline } = {}, log = () => {}) {
	const dir = deckDir(name);
	const have = await versions(name);
	const prev = have.length ? await readDeck(name, have.at(-1)) : null;
	if (prev && prev.kind !== "video") throw new Error(`${name} 是 pptx deck，视频换个名字发布`);
	const tlPath = timeline ? path.resolve(timeline) : timelineFor(source);
	if (timeline && !existsSync(tlPath)) throw new Error(`找不到 timeline：${tlPath}`);
	const tlBytes = existsSync(tlPath) ? await readFile(tlPath) : null;
	// The timeline is part of what is reviewed: a new one with the same video is a new version.
	const fullSha = tlBytes ? createHash("sha256").update(sha).update(tlBytes).digest("hex") : sha;
	if (prev && prev.sha === fullSha) return { deck: prev, unchanged: true };

	const meta = await probe(source);
	const tl = tlBytes ? readTimeline(JSON.parse(tlBytes), meta.duration) : { sources: [], scenes: [] };
	log(`video   ${meta.width}×${meta.height}  ${meta.duration.toFixed(1)}s  ${tl.scenes.length ? `${tl.scenes.length} 个场景` : "没有 timeline，只按时间批注"}`);

	const version = (have.at(-1) ?? 0) + 1;
	const tmp = path.join(dir, `.v${version}.tmp`);
	await rm(tmp, { recursive: true, force: true });
	await mkdir(tmp, { recursive: true });
	try {
		const t0 = Date.now();
		await copyFile(source, path.join(tmp, "video.mp4"));
		// A scene is unchanged when a scene with the same name, narration and pixels exists in the previous version.
		const prevByHash = new Map((prev?.scenes ?? []).map((s) => [s.hash, s.n]));
		const scenes = [];
		for (const [i, s] of tl.scenes.entries()) {
			const thumb = `t-${String(i + 1).padStart(3, "0")}.jpg`;
			await grab(source, s.start + (s.end - s.start) / 2, 320, path.join(tmp, thumb));
			const h = await scenePixels(source, s);
			h.update(JSON.stringify([s.name, Math.round((s.end - s.start) * 10), s.beats.map((b) => b.text)]));
			const hash = h.digest("hex").slice(0, 16);
			scenes.push({ n: i + 1, ...s, thumb, hash, same: prevByHash.get(hash) ?? null });
		}
		log(`frames  ${scenes.length} 个场景  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
		const deck = {
			kind: "video", name, version, source, sha: fullSha,
			file: path.basename(source),
			publishedAt: new Date().toISOString(),
			...meta,
			sources: tl.sources,
			changed: prev ? scenes.filter((s) => s.same == null).map((s) => s.n) : [],
			scenes,
		};
		await writeJson(path.join(tmp, "deck.json"), deck);
		await rename(tmp, path.join(dir, `v${version}`));
		await updateComments(name, (comments) => {
			for (const c of comments) if (c.status !== "open" && c.resolvedIn == null) c.resolvedIn = version;
		});
		return { deck, unchanged: false };
	} catch (e) {
		await rm(tmp, { recursive: true, force: true });
		throw e;
	}
}

// "192.5", "3:12", "1:03:12" -> seconds.
export function parseTime(s) {
	const parts = String(s).split(":").map(Number);
	if (!parts.length || parts.some((x) => !Number.isFinite(x) || x < 0)) return NaN;
	return parts.reduce((a, x) => a * 60 + x, 0);
}

// Full-size frame for Claude to look at; cached under data/<name>/frames/.
export async function frameFile(deck, t, box) {
	const tag = box ? `-box${box.map((x) => Math.round(x * 1000)).join("_")}` : "";
	const out = path.join(deckDir(deck.name), "frames", `v${deck.version}-${Math.round(t * 1000)}${tag}.png`);
	if (!existsSync(out)) {
		await mkdir(path.dirname(out), { recursive: true });
		await grab(path.join(deckDir(deck.name), `v${deck.version}`, "video.mp4"), t, deck.width, out, box);
	}
	return out;
}
