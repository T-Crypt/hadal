/**
 * The app icon as a PNG in chosen colors, drawn here: a phone adds a home-screen icon from an address it fetches, and
 * the server has no rasterizer or fonts. The drawing is that of `web/icon.svg`: the depth, the mark (its strokes come
 * from `icon-mask.ts` as coverage), and the point of light. Each pixel takes 3 × 3 samples.
 */
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { PI_MASK } from "./icon-mask.ts";

export type IconColors = { frame: string; card: string; ring1: string; ring2: string; pi: string };

/**
 * The colors of the icon: the depth (`frame`), the mark's strokes (`pi`), and the point of light (`card`). `ring1`
 * and `ring2` keep the stored five-color format and are not drawn.
 */
export const APP_ICON: IconColors = {
    frame: "#0A1014",
    card: "#65D9FF",
    ring1: "#33ccff",
    ring2: "#00ff99",
    pi: "#E5F1FC",
};

export const MIN_ICON = 64;
export const MAX_ICON = 1024;

const ART = 512;
/** The share of a maskable icon the art fills: 352 of 512 pixels. */
const SAFE = 352 / 512;
const mask = inflateSync(Buffer.from(PI_MASK.deflated, "base64"));

type Rgb = [number, number, number];

/** `#rgb` or `#rrggbb`, else null. */
export function parseHex(text: string): Rgb | null {
    const long = /^#?([0-9a-f]{6})$/i.exec(text)?.[1];
    const short = /^#?([0-9a-f]{3})$/i.exec(text)?.[1];
    const hex = long ?? short?.replace(/./g, "$&$&");

    if (hex === undefined) {
        return null;
    }

    return [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as Rgb;
}

function coverage(x: number, y: number): number {
    const at = (cx: number, cy: number) =>
        cx < 0 || cy < 0 || cx >= PI_MASK.width || cy >= PI_MASK.height
            ? 0
            : mask[cy * PI_MASK.width + cx]!;
    const fx = x - PI_MASK.x - 0.5;
    const fy = y - PI_MASK.y - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
    const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;

    return (top * (1 - ty) + bottom * ty) / 255;
}

/** The color at a point of the 512 × 512 drawing. */
function sample(x: number, y: number, c: Record<keyof IconColors, Rgb>): Rgb {
    let color: Rgb = c.frame;

    // The mark's strokes, in the ink color.
    const a = coverage(x, y);

    if (a > 0) {
        color = color.map((under, i) => under + (c.pi[i]! - under) * a) as Rgb;
    }

    // The point of light, on the mark: a circle at (256, 340) of radius 13.6, in the card's color.
    const b = Math.max(0, Math.min(1, 0.5 + (13.6 - Math.hypot(x - 256, y - 340))));

    if (b > 0) {
        color = color.map((under, i) => under + (c.card[i]! - under) * b) as Rgb;
    }

    return color;
}

function chunk(type: string, data: Buffer): Buffer {
    const head = Buffer.alloc(8);
    const tail = Buffer.alloc(4);

    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);

    return Buffer.concat([head, data, tail]);
}

/**
 * The icon as a PNG of `size` pixels (kept between MIN_ICON and MAX_ICON), or null for a color that is not hex. A
 * `maskable` icon, for the ones an OS crops itself, draws the art at 352 of 512 pixels (the safe zone) on the frame's color.
 */
export function renderIcon(colors: IconColors, size: number, maskable = false): Buffer | null {
    const parsed = Object.fromEntries(
        Object.entries(colors).map(([name, value]) => [name, parseHex(value)]),
    ) as Record<keyof IconColors, Rgb | null>;

    if (Object.values(parsed).some((value) => value === null)) {
        return null;
    }

    const c = parsed as Record<keyof IconColors, Rgb>;
    const n = Math.min(MAX_ICON, Math.max(MIN_ICON, Math.round(size)));
    const rows = Buffer.alloc(n * (n * 3 + 1));
    const scale = ART / n;

    for (let py = 0; py < n; py++) {
        const row = py * (n * 3 + 1);

        for (let px = 0; px < n; px++) {
            const sum = [0, 0, 0];

            for (let sy = 0; sy < 3; sy++) {
                for (let sx = 0; sx < 3; sx++) {
                    const x = (px + (sx + 0.5) / 3) * scale;
                    const y = (py + (sy + 0.5) / 3) * scale;
                    const rgb = maskable
                        ? sample(256 + (x - 256) / SAFE, 256 + (y - 256) / SAFE, c)
                        : sample(x, y, c);

                    sum[0]! += rgb[0];
                    sum[1]! += rgb[1];
                    sum[2]! += rgb[2];
                }
            }

            for (let i = 0; i < 3; i++) {
                rows[row + 1 + px * 3 + i] = Math.round(sum[i]! / 9);
            }
        }
    }

    const header = Buffer.alloc(13);

    header.writeUInt32BE(n, 0);
    header.writeUInt32BE(n, 4);
    header.set([8, 2, 0, 0, 0], 8);

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(rows)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}
