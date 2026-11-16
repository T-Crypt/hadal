// Marine snow: the water column HADAL floats in. One fixed canvas behind the app, 40 to 90 points drifting
// down slowly; near points share a faint line. The field answers the room: while an agent works in the open
// environment the drift eases back by 40 percent. No WebGL, no Preact state, 30 fps, a still frame when
// motion is off. Off below 700px and on touch-only pointers, where the field would cost battery for nothing.

import { store } from "./store.js";
import { motionLevel } from "./theme.js";

const MAX_FPS = 30;
const DPR_CAP = 1.5;
const LINK = 140;

function canvasElement() {
    const el = document.createElement("canvas");

    el.id = "atmosphere";
    el.setAttribute("aria-hidden", "true");
    document.body.prepend(el);

    return el;
}

/** Where the points are and how they fall. */
function field(width, height) {
    const count = Math.max(40, Math.min(90, Math.round((width * height) / 26000)));
    const points = [];

    for (let i = 0; i < count; i++) {
        points.push({
            x: Math.random() * width,
            y: Math.random() * height,
            v: 2 + Math.random() * 4, // px/s, two to six
            r: 0.6 + Math.random() * 1.2,
            phase: Math.random() * Math.PI * 2,
        });
    }

    return points;
}

/** Start the field, if this screen and this look should have one. Returns a stop for tests and safe mode. */
export function startAtmosphere() {
    if (
        document.getElementById("atmosphere") ||
        matchMedia("(max-width: 699px)").matches ||
        matchMedia("(pointer: coarse)").matches
    ) {
        return () => {};
    }

    const el = canvasElement();
    const ctx = el.getContext("2d", { alpha: true });
    let width = 0;
    let height = 0;
    let points = [];
    let frame = 0;
    let last = 0;
    let paused = document.hidden;

    const resize = () => {
        const ratio = Math.min(window.devicePixelRatio || 1, DPR_CAP);

        width = window.innerWidth;
        height = window.innerHeight;
        el.width = Math.round(width * ratio);
        el.height = Math.round(height * ratio);
        el.style.width = `${width}px`;
        el.style.height = `${height}px`;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        points = field(width, height);
    };

    // Read twice a second, not every frame: the open environment's state, and the palette's ink (a computed style
    // read forces the browser to work out every style first).
    let ease = 1;
    let ink = "";
    let sampled = -Infinity;

    const sample = (at) => {
        if (at - sampled < 500) {
            return;
        }

        sampled = at;
        ink = getComputedStyle(el).color;

        const { sessions = [], conversationId } = store.state;
        const open = sessions.find((session) => session.id === conversationId);
        // While an agent works in the open environment (any environment, on the home screen), the drift eases.
        const working = sessions.some(
            (session) =>
                session.busy &&
                !session.archived &&
                (open === undefined || session.cwd === open.cwd),
        );

        ease = working ? 0.6 : 1;
    };

    const step = (at) => {
        frame = requestAnimationFrame(step);

        if (paused || at - last < 1000 / MAX_FPS) {
            return;
        }

        const dt = Math.min((at - last) / 1000, 0.25);

        last = at;
        ctx.clearRect(0, 0, width, height);
        sample(at);
        ctx.strokeStyle = ink;
        ctx.fillStyle = ink;

        for (const p of points) {
            p.y += p.v * ease * dt;
            p.x += Math.sin(at / 3200 + p.phase) * 2.2 * dt;

            if (p.y > height + 4) {
                p.y = -4;
                p.x = Math.random() * width;
            }
        }

        // One path for the lines and one for the points: a stroke or fill per shape costs a draw call each.
        ctx.globalAlpha = 0.08;
        ctx.beginPath();

        for (let i = 0; i < points.length; i++) {
            for (let j = i + 1; j < points.length; j++) {
                const a = points[i];
                const b = points[j];

                if (Math.abs(a.x - b.x) < LINK && Math.abs(a.y - b.y) < LINK) {
                    ctx.moveTo(a.x, a.y);
                    ctx.lineTo(b.x, b.y);
                }
            }
        }

        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.beginPath();

        for (const p of points) {
            ctx.moveTo(p.x + p.r, p.y);
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        }

        ctx.fill();

        ctx.globalAlpha = 1;
    };

    const still = () => {
        resize();
        last = performance.now();
        step(last);
        cancelAnimationFrame(frame);
    };

    const onVisibility = () => {
        paused = document.hidden;
        last = performance.now();
    };

    // A drag-resize of a window must not compete with the field.
    const onPointer = (event) => {
        if (event.target.closest?.(".resize-handle")) {
            paused = true;

            const resume = () => {
                paused = document.hidden;
                last = performance.now();
                window.removeEventListener("pointerup", resume);
            };

            window.addEventListener("pointerup", resume);
        }
    };

    const onResize = () => resize();

    resize();

    if (motionLevel() === "reduced") {
        still();
    } else {
        frame = requestAnimationFrame(step);
    }

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("resize", onResize);
    window.addEventListener("pointerdown", onPointer);

    return () => {
        cancelAnimationFrame(frame);
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("resize", onResize);
        window.removeEventListener("pointerdown", onPointer);
        el.remove();
    };
}
