// Read the parts of a .pptx that the viewer needs: slide order, slide size,
// and each slide's XML with its layout and master.
import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

export const NS = {
	a: "http://schemas.openxmlformats.org/drawingml/2006/main",
	p: "http://schemas.openxmlformats.org/presentationml/2006/main",
	r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
};

const parse = (xml) => new DOMParser().parseFromString(xml.replace(/^\uFEFF/, ""), "text/xml");

async function text(zip, name) {
	const f = zip.file(name);
	if (!f) throw new Error(`${name} is missing from the pptx`);
	return f.async("string");
}

// Relationship targets of one part, keyed by rId; targets are resolved to zip paths.
async function rels(zip, part) {
	const relsName = path.posix.join(path.posix.dirname(part), "_rels", path.posix.basename(part) + ".rels");
	const f = zip.file(relsName);
	if (!f) return {};
	const out = {};
	for (const r of Array.from(parse(await f.async("string")).getElementsByTagName("Relationship"))) {
		const t = r.getAttribute("Target");
		out[r.getAttribute("Id")] = {
			type: r.getAttribute("Type").split("/").pop(),
			// "/ppt/x.xml" is relative to the package root, "x.xml" to the part's folder.
			target: t.startsWith("/") ? path.posix.normalize(t.slice(1)) : path.posix.normalize(path.posix.join(path.posix.dirname(part), t)),
		};
	}
	return out;
}

// Speaker notes live in the body placeholder of the notes slide; the other
// placeholders there are the slide image and the page number.
function notesText(doc) {
	for (const sp of Array.from(doc.getElementsByTagNameNS(NS.p, "sp"))) {
		const ph = sp.getElementsByTagNameNS(NS.p, "ph")[0];
		if (!ph || (ph.getAttribute("type") || "body") !== "body") continue;
		const paras = Array.from(sp.getElementsByTagNameNS(NS.a, "p")).map((p) =>
			Array.from(p.getElementsByTagNameNS(NS.a, "t")).map((t) => t.textContent).join(""),
		);
		return paras.join("\n").trim();
	}
	return "";
}

export async function openPptx(file) {
	const zip = await JSZip.loadAsync(await readFile(file));
	const pres = parse(await text(zip, "ppt/presentation.xml"));
	const sz = pres.getElementsByTagNameNS(NS.p, "sldSz")[0];
	const size = { cx: Number(sz.getAttribute("cx")), cy: Number(sz.getAttribute("cy")) };
	const presRels = await rels(zip, "ppt/presentation.xml");

	const cache = new Map(); // zip path -> { name, xml, doc, rels }
	async function part(name) {
		if (!cache.has(name)) {
			const xml = await text(zip, name);
			cache.set(name, { name, xml, doc: parse(xml), rels: await rels(zip, name) });
		}
		return cache.get(name);
	}
	const relOf = (p, type) => Object.values(p.rels).find((r) => r.type === type)?.target;

	const slides = [];
	for (const id of Array.from(pres.getElementsByTagNameNS(NS.p, "sldId"))) {
		const slide = await part(presRels[id.getAttributeNS(NS.r, "id")].target);
		const layout = await part(relOf(slide, "slideLayout"));
		const master = await part(relOf(layout, "slideMaster"));
		const notesName = relOf(slide, "notesSlide");
		const notes = notesName ? notesText((await part(notesName)).doc) : "";
		slides.push({ n: slides.length + 1, slide, layout, master, notes, hidden: slide.doc.documentElement.getAttribute("show") === "0" });
	}
	const themes = [];
	for (const name of Object.keys(zip.files).filter((n) => /^ppt\/theme\/theme\d+\.xml$/.test(n))) themes.push(await part(name));
	return { size, slides, themes };
}
