// Both rendered diagrams, emitted from the saga definition.
//
// A diagram that is drawn by hand drifts away from the specification it claims
// to illustrate, and the drift is invisible in the source and obvious in the
// picture. Three articles in this programme have shipped a rendered diagram
// that contradicted their own text. So these two are generated, `make verify`
// fails if the files on disk no longer match the definition, and the generator
// refuses to emit a drawing in which any arrow passes through any box.
//
// That last check is the one worth having. "Never route a line through a box"
// is a rule a human applies by looking; here it is an assertion with a line
// number.

import { compensableSteps, pivotIndex } from "./saga.ts";
import type { Definition, Route } from "./saga.ts";
import type { SagaState } from "./types.ts";

const INK = "#1b2f42";
const MID = "#41586e";
const MUTED = "#4d708c";
const LIGHT = "#f7f9fb";
const RED = "#b3453a";
const RED_DEEP = "#8f342b";
const RED_FILL = "#fdf4f2";
const GREEN = "#2f6b4f";
const GREEN_FILL = "#eef6f1";
const AMBER = "#8a6212";
const AMBER_FILL = "#fdf6e6";

const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";

interface Box {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface Segment {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Refuse to draw an arrow that passes through a box.
 *
 * Each segment is sampled; a sample strictly inside a box that is neither end
 * of the edge makes the generator throw, which makes `make verify` fail. The
 * inset keeps an arrowhead touching its own target from counting.
 */
function assertClear(
  segments: readonly Segment[], boxes: readonly Box[], from: string, to: string, label: string,
): void {
  const INSET = 3;
  for (const s of segments) {
    for (let t = 0; t <= 40; t += 1) {
      const x = s.x1 + ((s.x2 - s.x1) * t) / 40;
      const y = s.y1 + ((s.y2 - s.y1) * t) / 40;
      for (const b of boxes) {
        if (b.id === from || b.id === to) continue;
        if (x > b.x + INSET && x < b.x + b.w - INSET && y > b.y + INSET && y < b.y + b.h - INSET) {
          throw new Error(
            `edge ${from} --${label}--> ${to} passes through box ${b.id} at (${Math.round(x)}, ${Math.round(y)})`,
          );
        }
      }
    }
  }
}

function polyline(points: readonly (readonly [number, number])[], stroke: string, dash: string): string {
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0]} ${p[1]}`).join(" ");
  const dashAttr = dash === "" ? "" : ` stroke-dasharray="${dash}"`;
  return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.8"${dashAttr} marker-end="url(#arrow-${stroke.slice(1)})"/>`;
}

function toSegments(points: readonly (readonly [number, number])[]): Segment[] {
  const out: Segment[] = [];
  for (let i = 1; i < points.length; i += 1) {
    out.push({ x1: points[i - 1]![0], y1: points[i - 1]![1], x2: points[i]![0], y2: points[i]![1] });
  }
  return out;
}

function marker(colour: string): string {
  return `<marker id="arrow-${colour.slice(1)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${colour}"/></marker>`;
}

type Anchor = "middle" | "end";

function labelAt(
  x: number, y: number, text: string, colour: string, size: number, anchor: Anchor,
): string {
  const w = text.length * size * 0.54 + 12;
  const rx = anchor === "middle" ? x - w / 2 : x - w + 6;
  return [
    `<rect x="${rx.toFixed(1)}" y="${y - size + 1}" width="${w.toFixed(1)}" height="${size + 7}" rx="3" fill="#ffffff" opacity="0.94"/>`,
    `<text x="${x}" y="${y + 3}" text-anchor="${anchor}" font-family="${FONT}" font-size="${size}" fill="${colour}">${esc(text)}</text>`,
  ].join("");
}

// ---------------------------------------------------------------------------
// Diagram 1: the orchestrated saga
// ---------------------------------------------------------------------------

const SLOT_W = 176;
const SLOT_GAP = 46;
const LEFT = 48;
/** Room at the left for the end of the compensation chain. */
const GUTTER = 128;

export function sagaFlowSvg(def: Definition): string {
  const steps = def.steps;
  const pivot = pivotIndex(def);
  const comp = compensableSteps(def);
  const width = LEFT * 2 + GUTTER + steps.length * SLOT_W + (steps.length - 1) * SLOT_GAP;
  const height = 492;

  const slotX = (i: number): number => LEFT + GUTTER + i * (SLOT_W + SLOT_GAP);
  const stepY = 112;
  const stepH = 88;
  const compY = 258;
  const compH = 74;

  const boxes: Box[] = [];
  const parts: string[] = [];

  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  parts.push(`<text x="${LEFT}" y="44" font-family="${FONT}" font-size="21" font-weight="600" fill="${INK}">One saga, six steps, five services</text>`);
  parts.push(`<text x="${LEFT}" y="70" font-family="${FONT}" font-size="13.5" fill="${MUTED}">Generated from src/saga.ts. Forward commands run left to right; compensations run right to left and stop at the pivot.</text>`);

  // forward row
  steps.forEach((s, i) => {
    const x = slotX(i);
    const after = i >= pivot;
    const fill = after ? GREEN_FILL : LIGHT;
    const edge = after ? GREEN : MID;
    boxes.push({ id: `step-${s.name}`, x, y: stepY, w: SLOT_W, h: stepH });
    parts.push(`<rect x="${x}" y="${stepY}" width="${SLOT_W}" height="${stepH}" rx="7" fill="${fill}" stroke="${edge}" stroke-width="${s.pivot ? 2.4 : 1.3}"/>`);
    parts.push(`<text x="${x + 12}" y="${stepY + 24}" font-family="${FONT}" font-size="11" fill="${MUTED}">${esc(s.participant)}</text>`);
    parts.push(`<text x="${x + 12}" y="${stepY + 45}" font-family="${FONT}" font-size="13.5" font-weight="600" fill="${INK}">${esc(s.name)}</text>`);
    const tag = s.pivot ? "PIVOT" : s.async ? "answers later" : s.irreversible ? "irreversible" : after ? "retry forward" : "compensable";
    const tagColour = s.pivot ? GREEN : s.irreversible ? AMBER : MUTED;
    parts.push(`<text x="${x + 12}" y="${stepY + 68}" font-family="${FONT}" font-size="11.5" font-weight="600" fill="${tagColour}">${esc(tag)}</text>`);
    parts.push(`<text x="${x + SLOT_W - 12}" y="${stepY + 24}" text-anchor="end" font-family="${FONT}" font-size="11" fill="${MUTED}">${i + 1}</text>`);
  });

  // forward arrows
  for (let i = 0; i < steps.length - 1; i += 1) {
    const a: [number, number] = [slotX(i) + SLOT_W, stepY + stepH / 2];
    const b: [number, number] = [slotX(i + 1) - 4, stepY + stepH / 2];
    assertClear(toSegments([a, b]), boxes, `step-${steps[i]!.name}`, `step-${steps[i + 1]!.name}`, "next");
    parts.push(polyline([a, b], MID, ""));
  }

  // the pivot line
  const pivotX = slotX(pivot) - SLOT_GAP / 2;
  parts.push(`<path d="M ${pivotX} ${stepY - 26} L ${pivotX} ${compY + compH + 26}" stroke="${GREEN}" stroke-width="1.6" stroke-dasharray="6 5"/>`);
  parts.push(`<text x="${pivotX + 8}" y="${stepY - 32}" font-family="${FONT}" font-size="12" font-weight="600" fill="${GREEN}">no way back from here</text>`);

  // compensation row
  comp.forEach((s) => {
    const i = steps.findIndex((x) => x.name === s.name);
    const x = slotX(i);
    boxes.push({ id: `comp-${s.name}`, x, y: compY, w: SLOT_W, h: compH });
    parts.push(`<rect x="${x}" y="${compY}" width="${SLOT_W}" height="${compH}" rx="7" fill="${RED_FILL}" stroke="${RED}" stroke-width="1.3"/>`);
    parts.push(`<text x="${x + 12}" y="${compY + 22}" font-family="${FONT}" font-size="11" fill="${RED_DEEP}">compensation</text>`);
    parts.push(`<text x="${x + 12}" y="${compY + 43}" font-family="${FONT}" font-size="13" font-weight="600" fill="${INK}">${esc(s.compensation ?? "")}</text>`);
    parts.push(`<text x="${x + 12}" y="${compY + 62}" font-family="${FONT}" font-size="11" fill="${MUTED}">${esc(s.compensationDoes ?? "")}</text>`);
    // drop line from the step to its compensation
    const a: [number, number] = [x + SLOT_W / 2, stepY + stepH];
    const b: [number, number] = [x + SLOT_W / 2, compY - 4];
    assertClear(toSegments([a, b]), boxes, `step-${s.name}`, `comp-${s.name}`, "undone by");
    parts.push(polyline([a, b], RED, "4 4"));
  });

  // the chain, right to left
  for (let i = comp.length - 1; i > 0; i -= 1) {
    const hi = steps.findIndex((x) => x.name === comp[i]!.name);
    const lo = steps.findIndex((x) => x.name === comp[i - 1]!.name);
    const a: [number, number] = [slotX(hi), compY + compH / 2 + 12];
    const b: [number, number] = [slotX(lo) + SLOT_W + 4, compY + compH / 2 + 12];
    assertClear(toSegments([a, b]), boxes, `comp-${comp[i]!.name}`, `comp-${comp[i - 1]!.name}`, "then");
    parts.push(polyline([a, b], RED, ""));
  }

  // Where the chain enters.
  //
  // Deliberately not a box. An arrow leaving an annotation box is one of the
  // ways a rendered diagram comes to assert something its article denies, and
  // this programme has shipped it before: a reader sees the annotation as a
  // participant. So the cause is text, and only the arrow is drawn.
  const lastComp = comp[comp.length - 1]!;
  const li = steps.findIndex((x) => x.name === lastComp.name);
  const entryX = slotX(pivot) + 128;
  parts.push(`<text x="${slotX(pivot) + 6}" y="${compY + 26}" font-family="${FONT}" font-size="12" font-weight="600" fill="${RED_DEEP}">a step before the pivot is refused,</text>`);
  parts.push(`<text x="${slotX(pivot) + 6}" y="${compY + 44}" font-family="${FONT}" font-size="12" font-weight="600" fill="${RED_DEEP}">or never answers</text>`);
  const ea: [number, number] = [entryX, compY + compH / 2 + 12];
  const eb: [number, number] = [slotX(li) + SLOT_W + 4, compY + compH / 2 + 12];
  assertClear(toSegments([ea, eb]), boxes, "", `comp-${lastComp.name}`, "start the chain");
  parts.push(polyline([ea, eb], RED, ""));

  // the end of the chain
  const firstComp = comp[0]!;
  const fi = steps.findIndex((x) => x.name === firstComp.name);
  const fa: [number, number] = [slotX(fi), compY + compH / 2 + 12];
  const fb: [number, number] = [LEFT + 10, compY + compH / 2 + 12];
  assertClear(toSegments([fa, fb]), boxes, `comp-${firstComp.name}`, "end", "then");
  parts.push(polyline([fa, fb], RED, ""));
  parts.push(`<text x="${LEFT + 2}" y="${compY + compH / 2 - 2}" text-anchor="start" font-family="${FONT}" font-size="12.5" font-weight="600" fill="${RED_DEEP}">COMPENSATED</text>`);
  parts.push(`<text x="${LEFT + 2}" y="${compY + compH / 2 + 38}" text-anchor="start" font-family="${FONT}" font-size="11" fill="${MUTED}">nothing is left live</text>`);

  // the band under the forward-only half
  const bandX = slotX(pivot);
  const bandW = slotX(steps.length - 1) + SLOT_W - bandX;
  parts.push(`<rect x="${bandX}" y="${compY + compH + 26}" width="${bandW}" height="46" rx="6" fill="${GREEN_FILL}" stroke="${GREEN}" stroke-width="1.1"/>`);
  parts.push(`<text x="${bandX + 14}" y="${compY + compH + 54}" font-family="${FONT}" font-size="12.5" fill="${INK}">After the pivot there is nothing to go back to: these steps are retried, and then handed to an operator.</text>`);

  parts.push(`<text x="${LEFT}" y="${height - 18}" font-family="${FONT}" font-size="11.5" fill="${MUTED}">Every box and every arrow is a row in the definition. The generator refuses to emit a drawing in which an arrow crosses a box.</text>`);

  const defs = `<defs>${marker(MID)}${marker(RED)}${marker(GREEN)}</defs>`;
  const title = `<title>Orchestrated saga: six steps across five services, with the compensation chain beneath</title>`;
  const desc = `<desc>${esc(
    `Six step boxes in a row, numbered one to six: ${steps.map((s) => `${s.name} at ${s.participant}`).join("; ")}. ` +
    `Arrows run left to right between them. A dashed vertical line before ${steps[pivot]!.name} marks the pivot, labelled "no way back from here". ` +
    `Below the first ${comp.length} steps sit their compensation boxes — ${comp.map((s) => s.compensation).join(", ")} — joined to their steps by dashed vertical arrows and chained right to left, ending at a label reading COMPENSATED. ` +
    `To the right of the compensation row, two lines of red text read "a step before the pivot is refused, or never answers", and an arrow runs from under them leftwards into the first compensation box. ` +
    `A band under the last three steps reads "After the pivot there is nothing to go back to: these steps are retried, and then handed to an operator."`,
  )}</desc>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">${title}${desc}${defs}${parts.join("")}</svg>\n`;
}

// ---------------------------------------------------------------------------
// Diagram 2: the saga's own state machine
// ---------------------------------------------------------------------------

const BOX_W = 186;
const BOX_H = 58;
const COL_GAP = 94;
const ROW_GAP = 54;
const S_LEFT = 54;
const S_TOP = 168;

export function sagaStatesSvg(def: Definition): string {
  const colX = (c: number): number => S_LEFT + c * (BOX_W + COL_GAP);
  const rowY = (r: number): number => S_TOP + r * (BOX_H + ROW_GAP);
  const width = S_LEFT * 2 + 4 * BOX_W + 3 * COL_GAP;
  const laneAbove = 116;
  const laneBelow1 = rowY(3) + BOX_H + 40;
  const laneBelow2 = laneBelow1 + 28;
  const height = laneBelow2 + 56;

  const boxes: Box[] = [];
  const parts: string[] = [];
  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  parts.push(`<text x="${S_LEFT}" y="44" font-family="${FONT}" font-size="21" font-weight="600" fill="${INK}">Where a saga execution can be</text>`);
  parts.push(`<text x="${S_LEFT}" y="70" font-family="${FONT}" font-size="13.5" fill="${MUTED}">Eight states and eleven transitions, generated from src/saga.ts. Two states are left only by a person, and both name who.</text>`);

  const colourOf = (s: SagaState): readonly [string, string] => {
    if (def.terminal.includes(s)) return s === "COMPLETED" ? [GREEN_FILL, GREEN] : [LIGHT, MID];
    if (def.owned[s] !== undefined) return [AMBER_FILL, AMBER];
    if (s === "COMPENSATING") return [RED_FILL, RED];
    return [LIGHT, MID];
  };

  for (const s of def.states) {
    const l = def.layout[s];
    const x = colX(l.col);
    const y = rowY(l.row);
    boxes.push({ id: s, x, y, w: BOX_W, h: BOX_H });
    const [fill, edge] = colourOf(s);
    parts.push(`<rect x="${x}" y="${y}" width="${BOX_W}" height="${BOX_H}" rx="7" fill="${fill}" stroke="${edge}" stroke-width="${def.terminal.includes(s) ? 2.2 : 1.3}"/>`);
    parts.push(`<text x="${x + BOX_W / 2}" y="${y + (def.owned[s] === undefined ? 35 : 28)}" text-anchor="middle" font-family="${FONT}" font-size="13.5" font-weight="600" fill="${INK}">${esc(s)}</text>`);
    const owner = def.owned[s];
    if (owner !== undefined) {
      parts.push(`<text x="${x + BOX_W / 2}" y="${y + 46}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${AMBER}">owned by ${esc(owner)}</text>`);
    }
  }

  const boxOf = (s: SagaState): Box => boxes.find((b) => b.id === s)!;

  for (const t of def.transitions) {
    const route = def.routes[`${t.from}|${t.trigger}`];
    if (route === undefined) {
      throw new Error(`transition ${t.from} --${t.trigger}--> ${t.to} has no route; add one to src/saga.ts`);
    }
    const a = boxOf(t.from);
    const b = boxOf(t.to);
    const colour = t.trigger.startsWith("operator_") ? AMBER : t.to === "COMPLETED" ? GREEN : t.from === "COMPENSATING" || t.to === "COMPENSATING" ? RED : MID;
    const pts = routePoints(route, a, b);
    assertClear(toSegments(pts), boxes, t.from, t.to, t.trigger);
    parts.push(polyline(pts, colour, ""));
    const spot = labelPoint(route, pts, a, b);
    parts.push(labelAt(spot[0], spot[1], t.trigger, colour, 11, spot[2]));
  }

  parts.push(`<text x="${S_LEFT}" y="${height - 18}" font-family="${FONT}" font-size="11.5" fill="${MUTED}">A transition added without a declared route makes the generator throw, so the picture cannot fall behind the table.</text>`);

  function routePoints(route: Route, a: Box, b: Box): (readonly [number, number])[] {
    const am = a.y + a.h / 2;
    const bm = b.y + b.h / 2;
    if (route === "straight") {
      return [[a.x + a.w, am], [b.x - 4, bm]];
    }
    if (route === "elbow") {
      const midX = (a.x + a.w + b.x) / 2;
      return [[a.x + a.w, am], [midX, am], [midX, bm], [b.x - 4, bm]];
    }
    if (route === "lane-above") {
      const ax = a.x + a.w / 2 - 28;
      const bx = b.x + b.w / 2 - 28;
      return [[ax, a.y], [ax, laneAbove], [bx, laneAbove], [bx, b.y - 4]];
    }
    const lane = route === "lane-below" ? laneBelow1 : laneBelow2;
    const off = route === "lane-below" ? -28 : 28;
    const ax = a.x + a.w / 2 + off;
    const bx = b.x + b.w / 2 + off;
    return [[ax, a.y + a.h], [ax, lane], [bx, lane], [bx, b.y + b.h + 4]];
  }

  /**
   * Where a transition's name goes.
   *
   * Not "the middle of the longest horizontal run", which was the first
   * attempt and put five of the eleven labels on top of a box border. A
   * straight arrow is labelled above the row it runs along; an elbow is
   * labelled beside its vertical segment, on the side where no box sits; a
   * lane is labelled on the lane itself.
   */
  function labelPoint(
    route: Route, pts: (readonly [number, number])[], a: Box, b: Box,
  ): readonly [number, number, Anchor] {
    if (route === "straight") {
      return [(a.x + a.w + b.x) / 2, Math.min(a.y, b.y) - 12, "middle"];
    }
    if (route === "elbow") {
      const midX = (a.x + a.w + b.x) / 2;
      // Not the midpoint: on a two-row elbow the midpoint lands exactly on
      // the horizontal arrow of the row in between, and a label with a white
      // halo sitting in the middle of an arrow reads as a break in it.
      const am = a.y + a.h / 2;
      const bm = b.y + b.h / 2;
      return [midX - 7, am + (bm - am) * 0.72, "end"];
    }
    let best = 0;
    let bx = pts[0]![0];
    let by = pts[0]![1];
    for (let i = 1; i < pts.length; i += 1) {
      const dx = Math.abs(pts[i]![0] - pts[i - 1]![0]);
      if (dx > best) {
        best = dx;
        bx = (pts[i]![0] + pts[i - 1]![0]) / 2;
        by = pts[i]![1] - 7;
      }
    }
    return [bx, by, "middle"];
  }

  const defs = `<defs>${marker(MID)}${marker(RED)}${marker(GREEN)}${marker(AMBER)}</defs>`;
  const title = `<title>The saga execution state machine, including compensation failure and manual repair</title>`;
  const desc = `<desc>${esc(
    `Eight boxes. ${def.states.join(", ")}. ` +
    def.transitions.map((t) => `${t.from} to ${t.to} on ${t.trigger}`).join("; ") + ". " +
    `COMPENSATION_FAILED and MANUAL_REPAIR are shaded amber and labelled "owned by payments operations"; they are left only by an operator. ` +
    `COMPLETED, COMPENSATED and CLOSED_MANUALLY are terminal and have no outgoing arrow.`,
  )}</desc>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">${title}${desc}${defs}${parts.join("")}</svg>\n`;
}
