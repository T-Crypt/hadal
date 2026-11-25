/**
 * Classifies a model by the company that makes it and the region that company sits in.
 * Folder locks use this to allow only Claude or US cloud models in a locked folder.
 * The module is pure: no file system, no network.
 */

export type OriginRegion = "local" | "us" | "eu" | "cn" | "other" | "unknown";

export interface ModelOrigin {
    readonly company: string;
    readonly region: OriginRegion;
    readonly reason: string;
}

export type LockPolicy =
    | { readonly scope: "local" }
    | { readonly scope: "anthropic" }
    | { readonly scope: "us" }
    | { readonly scope: "custom"; readonly companies: readonly string[] };

/** The date the maker table below was last checked by a person. */
export const REGISTRY_REVIEWED = "2026-11-25";

interface Family {
    readonly company: string;
    readonly region: OriginRegion;
    readonly test: RegExp;
}

interface Provider {
    readonly company: string;
    readonly region: OriginRegion;
}

// Model families, in the order they are checked.
const FAMILIES: readonly Family[] = [
    // US makers.
    { company: "Anthropic", region: "us", test: /claude/ },
    { company: "OpenAI", region: "us", test: /(^|[^a-z0-9])(gpt|o1|o3|o4)(?![a-z0-9])/ },
    { company: "Google", region: "us", test: /gemini/ },
    { company: "Google", region: "us", test: /gemma/ },
    { company: "xAI", region: "us", test: /grok/ },
    { company: "Meta", region: "us", test: /llama/ },
    { company: "Amazon", region: "us", test: /(^|[^a-z0-9])nova(?![a-z0-9])/ },
    { company: "Microsoft", region: "us", test: /(^|[^a-z0-9])phi(?![a-z0-9])/ },
    { company: "IBM", region: "us", test: /granite/ },
    { company: "AI2", region: "us", test: /olmo/ },
    { company: "NVIDIA", region: "us", test: /nemotron/ },
    { company: "Perplexity", region: "us", test: /(^|[^a-z0-9])(sonar|pplx)(?![a-z0-9])/ },
    { company: "Databricks", region: "us", test: /dbrx/ },
    { company: "Snowflake", region: "us", test: /(^|[^a-z0-9])arctic(?![a-z0-9])/ },
    // Chinese makers.
    { company: "DeepSeek", region: "cn", test: /deepseek/ },
    { company: "Alibaba", region: "cn", test: /(qwen|qwq)/ },
    { company: "Zhipu AI", region: "cn", test: /(glm|chatglm|zhipu)/ },
    { company: "Moonshot AI", region: "cn", test: /(kimi|moonshot)/ },
    { company: "MiniMax", region: "cn", test: /minimax/ },
    { company: "ByteDance", region: "cn", test: /(^|[^a-z0-9])seed(?![a-z0-9])/ },
    { company: "Tencent", region: "cn", test: /(hunyuan|^hy\d)/ },
    { company: "Meituan", region: "cn", test: /longcat/ },
    { company: "Xiaomi", region: "cn", test: /mimo/ },
    { company: "Baidu", region: "cn", test: /ernie/ },
    { company: "StepFun", region: "cn", test: /(step-|stepfun)/ },
    { company: "Ant Group", region: "cn", test: /inclusion/ },
    // European makers.
    { company: "Mistral AI", region: "eu", test: /(mistral|mixtral|codestral)/ },
    // Other regions.
    { company: "Cohere", region: "other", test: /(^|[^a-z0-9])command(?![a-z0-9])/ },
    { company: "Cohere", region: "other", test: /(^|[^a-z0-9])aya(?![a-z0-9])/ },
    { company: "TII", region: "other", test: /(^|[^a-z0-9])falcon(?![a-z0-9])/ },
    { company: "AI21", region: "other", test: /jamba/ },
    { company: "Stability AI", region: "other", test: /stablelm/ },
    { company: "Reka", region: "other", test: /reka/ },
];

const PROVIDERS: Readonly<Record<string, Provider>> = {
    anthropic: { company: "Anthropic", region: "us" },
    openai: { company: "OpenAI", region: "us" },
    google: { company: "Google", region: "us" },
    xai: { company: "xAI", region: "us" },
    "x-ai": { company: "xAI", region: "us" },
    amazon: { company: "Amazon", region: "us" },
    microsoft: { company: "Microsoft", region: "us" },
    nvidia: { company: "NVIDIA", region: "us" },
    perplexity: { company: "Perplexity", region: "us" },
    together: { company: "Together AI", region: "us" },
    fireworks: { company: "Fireworks AI", region: "us" },
    baseten: { company: "Baseten", region: "us" },
    cloudflare: { company: "Cloudflare", region: "us" },
    thinkingmachines: { company: "Thinking Machines", region: "us" },
    liquid: { company: "Liquid AI", region: "us" },
    morph: { company: "Morph", region: "us" },
    parallel: { company: "Parallel", region: "us" },
    relace: { company: "Relace", region: "us" },
    reflection: { company: "Reflection", region: "us" },
    typesafe: { company: "TypeSafe", region: "us" },
    ai2: { company: "AI2", region: "us" },
    allenai: { company: "AI2", region: "us" },
    databricks: { company: "Databricks", region: "us" },
    snowflake: { company: "Snowflake", region: "us" },
    togethercomputer: { company: "Together AI", region: "us" },
    meta: { company: "Meta", region: "us" },
    "meta-llama": { company: "Meta", region: "us" },
    ibm: { company: "IBM", region: "us" },
    "ibm-granite": { company: "IBM", region: "us" },
    qwen: { company: "Alibaba", region: "cn" },
    "z-ai": { company: "Zhipu AI", region: "cn" },
    zhipu: { company: "Zhipu AI", region: "cn" },
    moonshotai: { company: "Moonshot AI", region: "cn" },
    moonshot: { company: "Moonshot AI", region: "cn" },
    bytedance: { company: "ByteDance", region: "cn" },
    "bytedance-seed": { company: "ByteDance", region: "cn" },
    tencent: { company: "Tencent", region: "cn" },
    xiaomi: { company: "Xiaomi", region: "cn" },
    baidu: { company: "Baidu", region: "cn" },
    stepfun: { company: "StepFun", region: "cn" },
    inclusionai: { company: "Ant Group", region: "cn" },
    mistralai: { company: "Mistral AI", region: "eu" },
    mistral: { company: "Mistral AI", region: "eu" },
    cohere: { company: "Cohere", region: "other" },
    upstage: { company: "Upstage", region: "other" },
    sakana: { company: "Sakana AI", region: "other" },
    "black-forest-labs": { company: "Black Forest Labs", region: "other" },
    sourceful: { company: "Sourceful", region: "other" },
    kt: { company: "KT", region: "other" },
};

const REGION_LABEL: Readonly<Record<OriginRegion, string>> = {
    local: "local",
    us: "US",
    eu: "EU",
    cn: "Chinese",
    other: "non-US",
    unknown: "unreviewed",
};

function reasonFor(company: string, region: OriginRegion, basis: string): string {
    return `${company} is a ${REGION_LABEL[region]} company, matched by ${basis}`;
}

function makerKey(id: string): string {
    const clean = id.trim().replace(/^~/, "").toLowerCase();
    const slash = clean.indexOf("/");

    if (slash > 0) {
        return clean.slice(0, slash);
    }

    return clean;
}

export function classify(input: {
    readonly provider: string;
    readonly id: string;
    readonly local: boolean;
}): ModelOrigin {
    if (input.local) {
        return {
            company: "local",
            region: "local",
            reason: "runs on this machine, the LAN, or the tailnet",
        };
    }

    const key = makerKey(input.id);
    const providerId = input.provider.trim().toLowerCase();

    for (const family of FAMILIES) {
        if (family.test.test(key)) {
            return {
                company: family.company,
                region: family.region,
                reason: reasonFor(family.company, family.region, "the model family name"),
            };
        }
    }

    // The vendor key of an id and the provider id share the same table, so a
    // vendor such as "anthropic" names the maker even when the id is opaque.
    const vendor = PROVIDERS[key];

    if (vendor) {
        return {
            company: vendor.company,
            region: vendor.region,
            reason: reasonFor(vendor.company, vendor.region, `the vendor "${key}"`),
        };
    }

    const provider = PROVIDERS[providerId];

    if (provider) {
        return {
            company: provider.company,
            region: provider.region,
            reason: reasonFor(provider.company, provider.region, `the provider "${providerId}"`),
        };
    }

    return {
        company: "unknown",
        region: "unknown",
        reason: "the maker is not in the reviewed registry",
    };
}

export function allows(policy: LockPolicy, origin: ModelOrigin): boolean {
    if (origin.region === "local") {
        return true;
    }

    switch (policy.scope) {
        case "local":
            return false;
        case "anthropic":
            return origin.company === "Anthropic";
        case "us":
            return origin.region === "us";
        case "custom":
            return policy.companies.includes(origin.company);
        default:
            return false;
    }
}

export function describePolicy(policy: LockPolicy): string {
    switch (policy.scope) {
        case "local":
            return "local models only";
        case "anthropic":
            return "local models and Anthropic";
        case "us":
            return "local models and US cloud models";

        case "custom": {
            if (policy.companies.length === 0) {
                return "local models only";
            }

            const names = policy.companies.join(", ");

            return `local models and ${names}`;
        }

        default:
            return "local models only";
    }
}

export function policyName(policy: LockPolicy): string {
    switch (policy.scope) {
        case "local":
            return "local";
        case "anthropic":
            return "claude";
        case "us":
            return "us";
        case "custom":
            return "custom";
        default:
            return "local";
    }
}

/** Whether a company name is on the US allowlist. A custom policy may hold only these. */
export function isUsCompany(company: string): boolean {
    return (
        FAMILIES.some((family) => family.company === company && family.region === "us") ||
        Object.values(PROVIDERS).some(
            (provider) => provider.company === company && provider.region === "us",
        )
    );
}

/** A policy from stored or posted JSON, checked; undefined when it is not one. */
export function parsePolicy(value: unknown): LockPolicy | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }

    const scope = (value as { scope?: unknown }).scope;

    if (scope === "local" || scope === "anthropic" || scope === "us") {
        return { scope };
    }

    if (scope !== "custom") {
        return undefined;
    }

    const companies = (value as { companies?: unknown }).companies;

    if (!Array.isArray(companies) || companies.length === 0 || companies.length > 32) {
        return undefined;
    }

    const names = companies.filter(
        (each): each is string => typeof each === "string" && isUsCompany(each),
    );

    if (names.length !== companies.length) {
        return undefined;
    }

    return { scope: "custom", companies: [...new Set(names)] };
}
