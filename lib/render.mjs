// pptx -> one PNG per slide (plus a small thumbnail), through soffice and pdftoppm.
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const DPI = 110;
const THUMB_W = 240;
// Hidden slides still get a page, so page k is always slide k.
const PDF_FILTER = 'pdf:impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}';

export async function render(pptx, outDir, slideCount) {
	const tmp = await mkdtemp(path.join(os.tmpdir(), "deck-render-"));
	try {
		// A private profile lets two renders run at once; soffice refuses to share one.
		const profile = "file://" + path.join(tmp, "profile");
		const src = path.join(tmp, "deck.pptx");
		await copyFile(pptx, src);
		await run("soffice", [`-env:UserInstallation=${profile}`, "--headless", "--convert-to", PDF_FILTER, "--outdir", tmp, src], { timeout: 300_000 });
		const pdf = path.join(tmp, "deck.pdf");
		await run("pdftoppm", ["-r", String(DPI), "-png", pdf, path.join(tmp, "s")], { timeout: 300_000 });
		await run("pdftoppm", ["-scale-to-x", String(THUMB_W), "-scale-to-y", "-1", "-png", pdf, path.join(tmp, "t")], { timeout: 300_000 });

		const files = (await readdir(tmp)).sort();
		const pages = files.filter((f) => /^s-\d+\.png$/.test(f));
		if (pages.length !== slideCount) {
			throw new Error(`soffice produced ${pages.length} pages for ${slideCount} slides`);
		}
		const pad = (f) => f.replace(/-(\d+)\.png$/, (_, d) => "-" + d.padStart(3, "0") + ".png");
		for (const f of files.filter((f) => /^[st]-\d+\.png$/.test(f))) await rename(path.join(tmp, f), path.join(outDir, pad(f)));
		return Array.from({ length: slideCount }, (_, i) => {
			const k = String(i + 1).padStart(3, "0");
			return { png: `s-${k}.png`, thumb: `t-${k}.png` };
		});
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
}
