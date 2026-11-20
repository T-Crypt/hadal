// The prompt's "model" section (`prompt.ts`): the session's model, and whether it reads images, so a model never has
// to guess its own vision.
import assert from "node:assert/strict";
import { test } from "node:test";
import { modelNote } from "../src/server/extensions/prompt.ts";

test("a model that takes images is told to look with read", () => {
    const text = modelNote("berth/Halocline-27B-UD-Q4_K_XL", true);

    assert.match(text, /^Your model: berth\/Halocline-27B-UD-Q4_K_XL\. It reads images:/);
    assert.match(text, /open it with the read tool/);
});

test("a text-only model is told read cannot show it an image", () => {
    assert.equal(
        modelNote("llama-swap/agent", false),
        "Your model: llama-swap/agent. It does not read images: the read tool cannot show you one, so work with an image through code.",
    );
});

test("an unknown model gets its name only", () => {
    assert.equal(modelNote("custom/x", undefined), "Your model: custom/x.");
});
