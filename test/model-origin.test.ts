import assert from "node:assert/strict";
import test from "node:test";
import {
    REGISTRY_REVIEWED,
    allows,
    classify,
    describePolicy,
    isUsCompany,
    parsePolicy,
    policyName,
} from "../src/server/model-origin.ts";

function origin(provider: string, id: string) {
    return classify({ provider, id, local: false });
}

test("the registry carries a review date", () => {
    assert.equal(REGISTRY_REVIEWED, "2026-11-25");
});

test("a local model is local whatever its name", () => {
    const found = classify({ provider: "llama-swap", id: "deepseek-r1", local: true });

    assert.deepEqual(found, {
        company: "local",
        region: "local",
        reason: "runs on this machine, the LAN, or the tailnet",
    });
});

test("US families are found in the model id", () => {
    const cases: Array<[string, string]> = [
        ["claude-sonnet-4", "Anthropic"],
        ["gpt-4o-mini", "OpenAI"],
        ["o1-preview", "OpenAI"],
        ["o3-mini", "OpenAI"],
        ["o4-mini", "OpenAI"],
        ["gemini-2.5-pro", "Google"],
        ["grok-4", "xAI"],
        ["llama-3.3-70b", "Meta"],
        ["amazon-nova-pro", "Amazon"],
        ["phi-4", "Microsoft"],
        ["granite-3.1-8b", "IBM"],
        ["olmo-2-7b", "AI2"],
    ];

    for (const [id, company] of cases) {
        const found = origin("openrouter", id);

        assert.equal(found.company, company, id);
        assert.equal(found.region, "us", id);
    }
});

test("Chinese families are found in the model id", () => {
    const cases: Array<[string, string]> = [
        ["deepseek-v3", "DeepSeek"],
        ["qwen3-32b", "Alibaba"],
        ["qwq-32b", "Alibaba"],
        ["glm-4.6", "Zhipu AI"],
        ["chatglm3", "Zhipu AI"],
        ["zhipu-air", "Zhipu AI"],
        ["kimi-k2", "Moonshot AI"],
        ["moonshot-v1", "Moonshot AI"],
        ["minimax-m2", "MiniMax"],
        ["seed-oss-36b", "ByteDance"],
        ["hunyuan-large", "Tencent"],
        ["hy3-preview", "Tencent"],
        ["longcat-flash", "Meituan"],
        ["mimo-7b", "Xiaomi"],
        ["ernie-4.5", "Baidu"],
        ["step-2-16k", "StepFun"],
        ["stepfun-pro", "StepFun"],
        ["inclusionai/lingma", "Ant Group"],
    ];

    for (const [id, company] of cases) {
        const found = origin("openrouter", id);

        assert.equal(found.company, company, id);
        assert.equal(found.region, "cn", id);
    }
});

test("EU and other families are found in the model id", () => {
    assert.equal(origin("openrouter", "mistral-large").region, "eu");
    assert.equal(origin("openrouter", "mixtral-8x7b").company, "Mistral AI");
    assert.equal(origin("openrouter", "codestral-2501").company, "Mistral AI");
    assert.equal(origin("openrouter", "command-r-plus").company, "Cohere");
    assert.equal(origin("openrouter", "command-r-plus").region, "other");
    assert.equal(origin("openrouter", "aya-expanse").company, "Cohere");
});

test("a vendor prefix names the maker", () => {
    assert.equal(origin("openrouter", "anthropic/claude-sonnet-4").company, "Anthropic");
    assert.equal(origin("openrouter", "deepseek/deepseek-v3").region, "cn");
    assert.equal(origin("openrouter", "meta-llama/llama-3.3-70b").company, "Meta");
    assert.equal(origin("openrouter", "~openai/gpt-4o").company, "OpenAI");
});

test("the provider is the fallback when no family matches", () => {
    const nvidia = origin("nvidia", "nemotron-70b");

    assert.equal(nvidia.company, "NVIDIA");
    assert.equal(nvidia.region, "us");

    const mistral = origin("mistral", "pixtral-large");

    assert.equal(mistral.company, "Mistral AI");
    assert.equal(mistral.region, "eu");

    const cohere = origin("cohere", "embed-v4");

    assert.equal(cohere.company, "Cohere");
    assert.equal(cohere.region, "other");
});

test("an unreviewed maker is unknown", () => {
    const found = origin("somegateway", "mystery-7b");

    assert.deepEqual(found, {
        company: "unknown",
        region: "unknown",
        reason: "the maker is not in the reviewed registry",
    });
});

test("local policy allows only local models", () => {
    const policy = { scope: "local" } as const;

    assert.equal(allows(policy, classify({ provider: "llama-swap", id: "x", local: true })), true);
    assert.equal(allows(policy, origin("anthropic", "claude-sonnet-4")), false);
});

test("anthropic policy allows local and Anthropic, and blocks OpenAI", () => {
    const policy = { scope: "anthropic" } as const;
    const claude = origin("openrouter", "claude-opus-4");
    const gpt = origin("openrouter", "gpt-5");

    assert.equal(allows(policy, claude), true);
    assert.equal(allows(policy, gpt), false);
    assert.equal(allows(policy, classify({ provider: "llama-swap", id: "x", local: true })), true);
});

test("us policy blocks DeepSeek and Mistral", () => {
    const policy = { scope: "us" } as const;

    assert.equal(allows(policy, origin("openrouter", "gpt-5")), true);
    assert.equal(allows(policy, origin("openrouter", "deepseek-v3")), false);
    assert.equal(allows(policy, origin("openrouter", "mistral-large")), false);
});

test("custom policy allows the listed companies only", () => {
    const policy = { scope: "custom", companies: ["Anthropic"] } as const;

    assert.equal(allows(policy, origin("openrouter", "claude-sonnet-4")), true);
    assert.equal(allows(policy, origin("openrouter", "gemini-2.5-pro")), false);
    assert.equal(allows(policy, classify({ provider: "llama-swap", id: "x", local: true })), true);
});

test("describePolicy names the allowed set", () => {
    assert.equal(describePolicy({ scope: "local" }), "local models only");
    assert.equal(describePolicy({ scope: "anthropic" }), "local models and Anthropic");
    assert.equal(describePolicy({ scope: "us" }), "local models and US cloud models");
    assert.equal(
        describePolicy({ scope: "custom", companies: ["Anthropic", "Google"] }),
        "local models and Anthropic, Google",
    );
});

test("policyName gives the short label", () => {
    assert.equal(policyName({ scope: "local" }), "local");
    assert.equal(policyName({ scope: "anthropic" }), "claude");
    assert.equal(policyName({ scope: "us" }), "us");
    assert.equal(policyName({ scope: "custom", companies: ["Anthropic"] }), "custom");
});

test("isUsCompany accepts the US allowlist and refuses others", () => {
    assert.equal(isUsCompany("Anthropic"), true);
    assert.equal(isUsCompany("OpenAI"), true);
    assert.equal(isUsCompany("TypeSafe"), true);
    assert.equal(isUsCompany("DeepSeek"), false);
    assert.equal(isUsCompany("Mistral AI"), false);
    assert.equal(isUsCompany("unknown"), false);
});

test("parsePolicy checks each scope and a custom list", () => {
    assert.deepEqual(parsePolicy({ scope: "local" }), { scope: "local" });
    assert.deepEqual(parsePolicy({ scope: "anthropic" }), { scope: "anthropic" });
    assert.deepEqual(parsePolicy({ scope: "us" }), { scope: "us" });
    assert.deepEqual(parsePolicy({ scope: "custom", companies: ["Anthropic", "OpenAI"] }), {
        scope: "custom",
        companies: ["Anthropic", "OpenAI"],
    });
    assert.equal(parsePolicy({ scope: "custom", companies: ["DeepSeek"] }), undefined);
    assert.equal(parsePolicy({ scope: "custom", companies: [] }), undefined);
    assert.equal(parsePolicy({ scope: "everything" }), undefined);
    assert.equal(parsePolicy(null), undefined);
});
