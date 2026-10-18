#!/usr/bin/env node
// deck — publish a pptx for browser review and act on the comments left there.
import { readFileSync } from "node:fs";
import { formatComments } from "../lib/prompt.mjs";
import { latest, MissingFontsError, publish } from "../lib/publish.mjs";
import { listDecks, readComments, readDeck, updateComments, versions } from "../lib/store.mjs";
import { frameFile, parseTime } from "../lib/video.mjs";

// Public URL of the viewer, printed after publish: $DECK_URL_BASE, else config.json's urlBase.
function urlBase() {
	if (process.env.DECK_URL_BASE) return process.env.DECK_URL_BASE;
	try {
		return JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8")).urlBase;
	} catch {
		return `http://127.0.0.1:${process.env.DECK_PORT || 7240}/`;
	}
}
const BASE = urlBase().replace(/\/?$/, "/");
const url = (name) => `${BASE}${name}/`;

const USAGE = `用法：
  deck publish <file.pptx> <name>      渲染并发布新版本，打印网址
  deck publish <video.mp4> <name> [--timeline <t.json>]
                                       发布视频；默认读同目录的 <video>.timeline.json
  deck frame <name> <时间> [--version <n>] [--box x,y,w,h]
                                       抽出视频某一时刻的画面，打印 PNG 路径；--box 把框画上去
  deck comments <name> [--all]         打印最新版的待处理批注（--all 含已处理），作为提示词
  deck resolve <name> <id> "<改了什么>"  标记已改
  deck resolve <name> <id> --skip "<原因>"  标记不改
  deck list                            列出所有 deck`;

function fail(msg) {
	console.error(msg);
	process.exit(1);
}

const [cmd, ...args] = process.argv.slice(2);

async function main() {
	switch (cmd) {
		case "publish": {
			const ti = args.indexOf("--timeline");
			const timeline = ti >= 0 ? args[ti + 1] : undefined;
			const [file, name] = ti >= 0 ? args.filter((_, i) => i !== ti && i !== ti + 1) : args;
			if (!file || !name || (ti >= 0 && !timeline)) fail(USAGE);
			try {
				const { deck, unchanged } = await publish(file, name, (l) => console.log(l), { timeline });
				const video = deck.kind === "video";
				if (unchanged) {
					console.log(`没有变化：和 v${deck.version} 的${video ? "视频和 timeline" : " pptx"} 完全相同`);
				} else {
					if (!video) console.log(`shapes  ${deck.slides.reduce((a, s) => a + s.shapes.length, 0)} 个形状`);
					const unit = video ? "场景" : "页";
					const changed = video ? deck.changed.map((n) => deck.scenes[n - 1].name).join(", ") : deck.changed.join(", ");
					if (deck.version > 1) console.log(`diff    v${deck.version} 对比 v${deck.version - 1}：${deck.changed.length ? `${video ? "场景 " : "第 "}${changed}${video ? " " : " 页"}有变化` : `没有${unit}变化`}`);
				}
				const open = (await readComments(name)).filter((c) => c.status === "open").length;
				console.log(`✓ ${url(name)}  (v${deck.version}${open ? `，${open} 条批注待处理` : ""})`);
			} catch (e) {
				if (!(e instanceof MissingFontsError)) throw e;
				fail(
					`✗ 停止发布：服务器缺字体 ${e.fonts.join("、")}。soffice 会换成别的字体，换行和溢出会和 PowerPoint 不一样。\n` +
						`  修法：把字体文件放进 ~/.local/share/fonts/deck/，运行 fc-cache -f；` +
						`字体名对不上时，在 server-deck/fonts/50-deck-aliases.conf 加别名。`,
				);
			}
			break;
		}
		case "comments": {
			const [name] = args;
			if (!name) fail(USAGE);
			const deck = await latest(name);
			// Only the latest version's comments matter; older versions are history.
			const all = (await readComments(name)).filter((c) => c.version === deck.version);
			const list = args.includes("--all") ? all : all.filter((c) => c.status === "open");
			if (!list.length) {
				console.log(`${name}：没有待处理的批注。网页：${url(name)}`);
				break;
			}
			console.log(formatComments(deck, list));
			if (args.includes("--all")) {
				for (const c of list.filter((c) => c.status !== "open")) console.log(`[${c.id}] ${c.status}${c.reply ? `：${c.reply}` : ""}`);
			}
			break;
		}
		case "resolve": {
			const skip = args.includes("--skip");
			const [name, id, reply] = args.filter((a) => a !== "--skip");
			if (!name || !id || !reply) fail(USAGE);
			const c = await updateComments(name, (comments) => {
				const c = comments.find((x) => x.id === id);
				if (!c) return null;
				Object.assign(c, { status: skip ? "skipped" : "done", reply, resolvedAt: new Date().toISOString() });
				delete c.resolvedIn; // stamped by the next publish
				return c;
			});
			if (!c) fail(`${name} 里没有批注 ${id}`);
			console.log(`[${id}] → ${c.status}：${reply}`);
			break;
		}
		case "frame": {
			const opt = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
			const skip = new Set(["--version", "--box"].flatMap((f) => (args.includes(f) ? [args.indexOf(f), args.indexOf(f) + 1] : [])));
			const [name, time] = args.filter((_, i) => !skip.has(i));
			const t = parseTime(time);
			const box = opt("--box")?.split(",").map(Number);
			if (!name || !Number.isFinite(t) || (box && (box.length !== 4 || box.some((x) => !(x >= 0 && x <= 1))))) fail(USAGE);
			const vi = args.indexOf("--version");
			const deck = vi >= 0 ? await readDeck(name, Number(args[vi + 1])) : await latest(name);
			if (deck.kind !== "video") fail(`${name} 不是视频`);
			if (t > deck.duration) fail(`${time} 超出视频长度 ${deck.duration.toFixed(1)}s`);
			console.log(await frameFile(deck, t, box));
			break;
		}
		case "list": {
			for (const name of await listDecks()) {
				const v = (await versions(name)).at(-1);
				if (!v) continue;
				const open = (await readComments(name)).filter((c) => c.status === "open").length;
				console.log(`${name}  v${v}  ${open} 条待处理  ${url(name)}`);
			}
			break;
		}
		default:
			fail(USAGE);
	}
}

main().catch((e) => fail(`✗ ${e.message}`));
