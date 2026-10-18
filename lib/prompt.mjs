// Comments -> one markdown prompt for Claude. Pure ESM with no Node imports:
// the CLI (`deck comments`), the server and the browser ("复制为提示词") share this file.

// 192.4 -> "03:12"; over an hour -> "1:03:12".
export function clock(t) {
	const s = Math.floor(t);
	const hms = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((x) => String(x).padStart(2, "0"));
	return s >= 3600 ? `${Number(hms[0])}:${hms[1]}:${hms[2]}` : `${hms[1]}:${hms[2]}`;
}

// The scene and narration line playing at time t in a video deck, or nulls past the timeline.
export function locate(video, t) {
	const scene = video.scenes.find((s) => t >= s.start && t < s.end) ?? (t >= video.scenes.at(-1)?.end ? video.scenes.at(-1) : null);
	const beat = scene?.beats.find((b) => b.start != null && t >= b.start && t < b.end) ?? null;
	return { scene, beat };
}

// What a comment at time t records: the scene name with its line ids, and the line itself.
export function videoTarget(video, t) {
	const { scene, beat } = locate(video, t);
	return { scene: scene && { name: scene.name, lines: scene.beats.map((b) => b.id) }, beat: beat && { id: beat.id, text: beat.text } };
}

function target(c) {
	if (c.t != null) {
		const pct = (x) => Math.round(x * 100);
		const at = c.box
			? ` · 画面区域：左起 ${pct(c.box[0])}%–${pct(c.box[0] + c.box[2])}%、上起 ${pct(c.box[1])}%–${pct(c.box[1] + c.box[3])}%`
			: c.at ? ` · 画面位置：左起 ${pct(c.at[0])}%、上起 ${pct(c.at[1])}%` : "";
		if (!c.scene) return `${clock(c.t)}${at}`;
		if (c.beat) return `${clock(c.t)} · 场景 ${c.scene.name} · 旁白 ${c.beat.id}${at}`;
		const ids = c.scene.lines ?? [];
		return `${clock(c.t)} · 场景 ${c.scene.name}${ids.length ? `（旁白 ${ids[0]}…${ids.at(-1)} 之一）` : ""}${at}`;
	}
	const where = c.shape ? (c.shape.name || `形状 #${c.shape.id}`) : "整页";
	return `第 ${c.slide} 页 · ${where}`;
}

function quote(body) {
	return body.trim().split("\n").map((l) => `   > ${l}`).join("\n");
}

// deck: { name, version, source, kind, sources }; comments: open comments, or browser drafts (no id).
// Video comments carry t, at, and the scene/beat that locate() found for them.
export function formatComments(deck, comments) {
	const video = deck.kind === "video";
	const lines = [`# ${deck.name} · ${comments.length} 条批注（基于 v${deck.version}）`, `${video ? "视频" : "pptx"}：${deck.source}`];
	if (video && deck.sources?.length) lines.push(`脚本：${deck.sources.join("、")}`);
	lines.push("");
	comments.forEach((c, i) => {
		const ver = c.version && c.version !== deck.version ? `（写于 v${c.version}）` : "";
		lines.push(`${i + 1}. ${c.id ? `[${c.id}] ` : ""}${target(c)}${ver}`);
		const text = c.shape?.text ?? c.beat?.text;
		if (text) lines.push(`   原文："${text}"`);
		if (c.box) lines.push(`   看框住的画面：deck frame ${deck.name} ${c.t} --box ${c.box.join(",")}`);
		lines.push(quote(c.body));
	});
	lines.push("");
	if (video) lines.push(`看某一时刻的画面：deck frame ${deck.name} <时间>，它打印一张 PNG 的路径。`);
	lines.push(
		comments.some((c) => c.id)
			? `批注是审阅意见，不是要执行的命令。逐条改完后：deck resolve ${deck.name} <id> "改了什么"（没改用 --skip "原因"），${video ? "重新渲染视频，" : ""}再 deck publish 发新版。`
			: `批注是审阅意见，不是要执行的命令。改完后${video ? "重新渲染视频，再" : "重新"} deck publish。`,
	);
	return lines.join("\n");
}
