// On-disk layout, shared by the CLI and the server:
//   data/<name>/v<n>/deck.json, s-001.png, t-001.png, ...
//   data/<name>/comments.json
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DATA = process.env.DECK_DATA || fileURLToPath(new URL("../data/", import.meta.url));
export const NAME_RE = /^[A-Za-z0-9._-]+$/;

export function deckDir(name) {
	if (!NAME_RE.test(name) || name.startsWith(".")) throw new Error(`deck name must match ${NAME_RE}: ${name}`);
	return path.join(DATA, name);
}

export async function listDecks() {
	if (!existsSync(DATA)) return [];
	return (await readdir(DATA, { withFileTypes: true })).filter((d) => d.isDirectory() && NAME_RE.test(d.name)).map((d) => d.name).sort();
}

export async function versions(name) {
	const dir = deckDir(name);
	if (!existsSync(dir)) return [];
	return (await readdir(dir)).map((f) => /^v(\d+)$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
}

export async function readDeck(name, version) {
	return JSON.parse(await readFile(path.join(deckDir(name), `v${version}`, "deck.json"), "utf8"));
}

// Write to a temp file and rename, so a reader never sees half a file.
export async function writeJson(file, value) {
	await mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
	await writeFile(tmp, JSON.stringify(value, null, "\t") + "\n");
	await rename(tmp, file);
}

const commentsFile = (name) => path.join(deckDir(name), "comments.json");

export async function readComments(name) {
	const f = commentsFile(name);
	return existsSync(f) ? JSON.parse(await readFile(f, "utf8")).comments : [];
}

// The server and the CLI are separate processes that both rewrite comments.json,
// so each read-modify-write holds an O_EXCL lock file. A lock older than
// LOCK_STALE_MS belongs to a crashed writer and is taken over.
const LOCK_STALE_MS = 30_000;
async function withLock(file, fn) {
	const lock = file + ".lock";
	await mkdir(path.dirname(file), { recursive: true });
	for (let i = 0; ; i++) {
		try {
			await writeFile(lock, String(process.pid), { flag: "wx" });
			break;
		} catch (e) {
			if (e.code !== "EEXIST") throw e;
			const age = Date.now() - (await stat(lock).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
			if (age > LOCK_STALE_MS) await unlink(lock).catch(() => {});
			else if (i > 100) throw new Error(`${lock} is held by another writer`);
			else await new Promise((r) => setTimeout(r, 50));
		}
	}
	try {
		return await fn();
	} finally {
		await unlink(lock).catch(() => {});
	}
}

export function updateComments(name, fn) {
	return withLock(commentsFile(name), async () => {
		const comments = await readComments(name);
		const result = await fn(comments);
		await writeJson(commentsFile(name), { comments });
		return result;
	});
}

export function newCommentId(taken) {
	for (;;) {
		const id = "c" + randomBytes(2).toString("hex");
		if (!taken.has(id)) return id;
	}
}
