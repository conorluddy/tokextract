import type { FlatToken } from "./dtcg";
import { toRgba } from "./color";

const PAGE_NAME = "Tokextract — Tokens";
const SWATCH = 96;
const GAP = 16;
const COLUMN = 6;

export async function buildSpecPage(tokens: FlatToken[]): Promise<PageNode> {
  const page = figma.createPage();
  page.name = PAGE_NAME;

  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  await figma.loadFontAsync({ family: "Inter", style: "Bold" });

  let y = 64;
  y = renderColors(page, tokens.filter((t) => t.type === "color"), y);
  y = renderTypography(page, tokens.filter((t) => t.type === "typography"), y);
  y = renderDimensions(page, tokens.filter((t) => t.type === "dimension"), y);

  return page;
}

function renderColors(page: PageNode, tokens: FlatToken[], top: number): number {
  if (tokens.length === 0) return top;
  const heading = makeHeading("Colors", 64, top);
  page.appendChild(heading);
  let y = top + 56;
  let column = 0;
  for (const token of tokens) {
    const rgba = toRgba(token.value);
    if (!rgba) continue;
    const swatch = figma.createRectangle();
    swatch.name = token.name;
    swatch.x = 64 + column * (SWATCH + GAP);
    swatch.y = y;
    swatch.resize(SWATCH, SWATCH);
    swatch.cornerRadius = 8;
    swatch.fills = [{ type: "SOLID", color: rgba, opacity: rgba.a }];
    page.appendChild(swatch);

    const label = figma.createText();
    label.fontName = { family: "Inter", style: "Regular" };
    label.fontSize = 11;
    label.characters = token.name;
    label.x = swatch.x;
    label.y = swatch.y + SWATCH + 8;
    label.resize(SWATCH, 16);
    page.appendChild(label);

    column++;
    if (column >= COLUMN) {
      column = 0;
      y += SWATCH + 48;
    }
  }
  return y + SWATCH + 96;
}

function renderTypography(page: PageNode, tokens: FlatToken[], top: number): number {
  if (tokens.length === 0) return top;
  const heading = makeHeading("Typography", 64, top);
  page.appendChild(heading);
  let y = top + 56;
  for (const token of tokens) {
    const sample = figma.createText();
    sample.fontName = { family: "Inter", style: "Regular" };
    sample.fontSize = 24;
    sample.characters = token.name;
    sample.x = 64;
    sample.y = y;
    page.appendChild(sample);
    y += 48;
  }
  return y + 64;
}

function renderDimensions(page: PageNode, tokens: FlatToken[], top: number): number {
  if (tokens.length === 0) return top;
  const heading = makeHeading("Dimensions", 64, top);
  page.appendChild(heading);
  let y = top + 56;
  for (const token of tokens) {
    const value = readPx(token.value);
    if (value === null) continue;
    const bar = figma.createRectangle();
    bar.x = 64;
    bar.y = y;
    bar.resize(Math.max(1, value), 16);
    bar.fills = [{ type: "SOLID", color: { r: 0.2, g: 0.4, b: 0.9 } }];
    page.appendChild(bar);

    const label = figma.createText();
    label.fontName = { family: "Inter", style: "Regular" };
    label.fontSize = 12;
    label.characters = `${token.name}  ·  ${value}px`;
    label.x = 64 + Math.max(1, value) + 12;
    label.y = y;
    page.appendChild(label);

    y += 28;
  }
  return y + 64;
}

function makeHeading(text: string, x: number, y: number): TextNode {
  const node = figma.createText();
  node.fontName = { family: "Inter", style: "Bold" };
  node.fontSize = 32;
  node.characters = text;
  node.x = x;
  node.y = y;
  return node;
}

function readPx(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "value" in (value as object)) {
    const v = value as { value: number };
    return typeof v.value === "number" ? v.value : null;
  }
  return null;
}
