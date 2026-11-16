// HADAL's docs: Starlight, on GitHub Pages at https://t-crypt.github.io/hadal/docs/, beside the product site (site/).
// `site` is the origin only: Pages serves the project under /hadal, and `base` below carries that path.
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { satteri } from "@astrojs/markdown-satteri";
import { idOf, pages, REPO, repoMarkdown, VERSION } from "./src/repo-docs.mjs";
import { SIDEBAR } from "./src/sidebar.mjs";

const listed = new Set(SIDEBAR.flatMap((group) => group.items.map(([path]) => path)));
const problems = [];

for (const path of pages()) {
    if (!listed.has(path)) {
        problems.push(`${path} is a page, but not in the sidebar (docs-site/src/sidebar.mjs)`);
    }
}

for (const path of listed) {
    if (!existsSync(join(REPO, path))) {
        problems.push(`${path} is in the sidebar, but not in the repository`);
    }
}

if (problems.length > 0) {
    throw new Error(`The sidebar and the pages differ:\n${problems.join("\n")}`);
}

const sidebar = SIDEBAR.map(({ label, collapsed, items }) => ({
    label,
    collapsed: collapsed ?? false,
    items: items.map(([path, text]) => ({ slug: idOf(path), label: text })),
}));

export default defineConfig({
    site: "https://t-crypt.github.io",
    base: "/hadal/docs",
    trailingSlash: "always",
    devToolbar: { enabled: false },
    markdown: {
        processor: satteri({ mdastPlugins: [repoMarkdown] }),
    },
    vite: {
        // Pages and components get HADAL's version this way: what they import is bundled, away from the repo.
        define: { __POCKET_VERSION__: JSON.stringify(VERSION) },
        server: { fs: { allow: [REPO] } },
    },
    integrations: [
        {
            // A copy of the public types beside the docs, for editors outside a HADAL: /hadal/docs/pocket.d.ts.
            name: "pocket-types",
            hooks: {
                "astro:build:done": ({ dir }) => {
                    const types = join(REPO, "types/pocket.d.ts");

                    if (existsSync(types)) {
                        copyFileSync(types, new URL("pocket.d.ts", dir));
                    }
                },
            },
        },
        starlight({
            title: "HADAL docs",
            description:
                "How HADAL works and how to extend it: the tour, the parts and how a message moves through them, running it on a server, and the extension API.",
            // A shared docs link gets the same card as the landing page; a phone gets the right chrome colour.
            head: [
                {
                    tag: "meta",
                    attrs: {
                        property: "og:image",
                        content: "https://t-crypt.github.io/hadal/og.png",
                    },
                },
                {
                    tag: "meta",
                    attrs: {
                        name: "twitter:image",
                        content: "https://t-crypt.github.io/hadal/og.png",
                    },
                },
                {
                    tag: "meta",
                    attrs: {
                        name: "theme-color",
                        content: "#0a1014",
                        media: "(prefers-color-scheme: dark)",
                    },
                },
                {
                    tag: "meta",
                    attrs: {
                        name: "theme-color",
                        content: "#eef1f4",
                        media: "(prefers-color-scheme: light)",
                    },
                },
            ],
            logo: { src: "./public/icon.svg", alt: "" },
            favicon: "/icon.svg",
            social: [
                {
                    icon: "github",
                    label: "GitHub",
                    href: "https://github.com/T-Crypt/hadal",
                },
            ],
            components: {
                Footer: "./src/components/Footer.astro",
                SocialIcons: "./src/components/SocialIcons.astro",
            },
            customCss: ["./src/styles/pocket.css"],
            markdown: { processedDirs: [REPO] },
            expressiveCode: { defaultProps: { wrap: true } },
            sidebar,
            lastUpdated: false,
            pagination: true,
            credits: false,
            disable404Route: true,
        }),
    ],
});
