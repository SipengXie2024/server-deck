// A deck renders like PowerPoint only if soffice has every font it names;
// otherwise fontconfig silently substitutes and line breaks move.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Local, not committed; see fonts/50-deck-aliases.conf.example.
const ALIASES = fileURLToPath(new URL("../fonts/50-deck-aliases.conf", import.meta.url));

// Font families the deck's theme, masters, layouts and slides ask for.
// "+mj-lt" style names point back at the theme and are skipped; the
// per-script <a:font> fallbacks in the theme are only used for those scripts.
export function usedFonts(deck) {
	const parts = new Set(deck.themes);
	for (const s of deck.slides) parts.add(s.slide).add(s.layout).add(s.master);
	const used = new Set();
	for (const p of parts) {
		for (const [, f] of p.xml.matchAll(/<a:(?:latin|ea) typeface="([^"]*)"/g)) {
			if (f && !f.startsWith("+")) used.add(f.replace(/&amp;/g, "&"));
		}
	}
	return [...used].sort();
}

// fc-match always returns some font, so compare against installed family names
// plus the aliases this project declares.
export function installedFamilies() {
	const out = execFileSync("fc-list", ["--format", "%{family}\n"], { encoding: "utf8" });
	const names = new Set(out.split(/[,\n]/).map((x) => x.trim()).filter(Boolean));
	const aliases = existsSync(ALIASES) ? readFileSync(ALIASES, "utf8") : "";
	for (const [, f] of aliases.matchAll(/<alias[^>]*>\s*<family>([^<]+)<\/family>/g)) names.add(f.trim());
	return names;
}

export function missingFonts(deck) {
	const have = installedFamilies();
	return usedFonts(deck).filter((f) => !have.has(f));
}
