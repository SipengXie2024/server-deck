// Shape boxes per slide, as fractions of the slide size, so the viewer can map
// a click on the rendered image back to the shape in the pptx.
import { NS } from "./pptx.mjs";

const TEXT_MAX = 120;
const BACKGROUND = 0.95; // a shape covering this much of the slide is a background, not a target

const kids = (el, ns, local) => Array.from(el.childNodes).filter((n) => n.nodeType === 1 && n.namespaceURI === ns && (!local || n.localName === local));
const kid = (el, ns, local) => kids(el, ns, local)[0];

function xfrmOf(el) {
	// p:graphicFrame keeps its transform at p:xfrm; everything else under *SpPr/a:xfrm.
	if (el.localName === "graphicFrame") return kid(el, NS.p, "xfrm");
	const pr = kids(el, NS.p).find((n) => n.localName === "spPr" || n.localName === "grpSpPr");
	return pr && kid(pr, NS.a, "xfrm");
}

function readXfrm(x) {
	if (!x) return null;
	const pt = (local, a, b) => {
		const e = kid(x, NS.a, local);
		return e ? [Number(e.getAttribute(a)), Number(e.getAttribute(b))] : null;
	};
	return { off: pt("off", "x", "y"), ext: pt("ext", "cx", "cy"), chOff: pt("chOff", "x", "y"), chExt: pt("chExt", "cx", "cy") };
}

function nvProps(el) {
	const nv = kids(el, NS.p).find((n) => /^nv/.test(n.localName));
	const c = nv && kid(nv, NS.p, "cNvPr");
	const ph = nv && kid(nv, NS.p, "nvPr") && kid(kid(nv, NS.p, "nvPr"), NS.p, "ph");
	return {
		id: c ? Number(c.getAttribute("id")) : 0,
		name: c ? c.getAttribute("name") : "",
		ph: ph ? { type: ph.getAttribute("type") || "body", idx: ph.getAttribute("idx") } : null,
	};
}

function allText(el) {
	const runs = Array.from(el.getElementsByTagNameNS(NS.a, "p")).map((p) =>
		Array.from(p.getElementsByTagNameNS(NS.a, "t")).map((t) => t.textContent).join(""),
	);
	return runs.filter(Boolean).join(" / ").replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);
}

// A placeholder with no a:xfrm takes its position from the layout, then the master.
function inheritedXfrm(ph, layout, master) {
	for (const part of [layout, master]) {
		for (const sp of Array.from(part.doc.getElementsByTagNameNS(NS.p, "sp"))) {
			const p = nvProps(sp).ph;
			if (!p) continue;
			const same = ph.idx != null && p.idx === ph.idx ? true : p.type === ph.type;
			const x = same && readXfrm(xfrmOf(sp));
			if (x?.off && x?.ext) return x;
		}
	}
	return null;
}

// Child coordinates of a group live in its chOff/chExt space; map them into the
// parent's space. Rotation and flips are ignored: boxes are axis-aligned.
const identity = (x, y, w, h) => [x, y, w, h];
function groupMap(g, outer) {
	const { off, ext, chOff, chExt } = g;
	const sx = chExt[0] ? ext[0] / chExt[0] : 1;
	const sy = chExt[1] ? ext[1] / chExt[1] : 1;
	return (x, y, w, h) => outer(off[0] + (x - chOff[0]) * sx, off[1] + (y - chOff[1]) * sy, w * sx, h * sy);
}

export function extractShapes(deck) {
	const { cx: W, cy: H } = deck.size;
	return deck.slides.map(({ n, slide, layout, master }) => {
		const shapes = [];
		const walk = (tree, map) => {
			for (const el of kids(tree, NS.p)) {
				if (!["sp", "pic", "graphicFrame", "grpSp"].includes(el.localName)) continue;
				const nv = nvProps(el);
				let x = readXfrm(xfrmOf(el));
				if ((!x?.off || !x?.ext) && nv.ph) x = inheritedXfrm(nv.ph, layout, master);
				if (!x?.off || !x?.ext) continue;
				const [bx, by, bw, bh] = map(x.off[0], x.off[1], x.ext[0], x.ext[1]);
				const box = [bx / W, by / H, bw / W, bh / H].map((v) => Math.round(v * 1e4) / 1e4);
				if (box[2] * box[3] < BACKGROUND) {
					shapes.push({ id: nv.id, name: nv.name, kind: el.localName, box, text: allText(el) });
				}
				if (el.localName === "grpSp" && x.chOff && x.chExt) walk(el, groupMap(x, map));
			}
		};
		walk(slide.doc.getElementsByTagNameNS(NS.p, "spTree")[0], identity);
		return { n, shapes };
	});
}
