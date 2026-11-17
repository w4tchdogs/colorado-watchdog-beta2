import assert from "node:assert/strict";
import test from "node:test";
import { EditorApiError } from "../dist/editor/api-client.js";
import {
  proposalBlocksToVisual,
  validateAiProposal,
  validateAiRequest,
} from "../dist/editor/ai-blocks.js";
import {
  createAiProposalService,
  createAiProviderFromEnv,
  createFixtureAiProvider,
  createOpenAiProvider,
} from "../dist/services/ai-proposals.js";
import { makeClient, startSandbox } from "./editor-fixtures.mjs";

const context = { title: "A fictional title", summary: null };
const selection = (
  operation,
  text = "A fictional paragraph.",
  instruction,
) => ({
  schema: 1,
  operation,
  text,
  ...(instruction === undefined ? {} : { instruction }),
  context,
});
const draft = (operation, instruction = "the fictional river survey") => ({
  schema: 1,
  operation,
  instruction,
  context,
});
const service = (options = {}) =>
  createAiProposalService({ provider: createFixtureAiProvider(), ...options });

test("requests are validated as a closed, bounded schema", () => {
  assert.ok(validateAiRequest(selection("rewrite")));
  assert.ok(validateAiRequest(selection("translate", "Text", "Spanish")));
  assert.ok(validateAiRequest(draft("draft_article")));
  for (const bad of [
    null,
    [],
    { ...selection("rewrite"), extra: 1 },
    { ...selection("rewrite"), schema: 2 },
    { ...selection("explode") },
    selection("rewrite", ""),
    selection("change_tone", "Text"),
    selection("rewrite", "x".repeat(8_001)),
    { ...draft("draft_article"), text: "not allowed" },
    draft("draft_article", ""),
    draft("draft_article", "x".repeat(1_001)),
    { ...draft("draft_article"), context: { title: "T" } },
    { ...draft("draft_article"), context: { title: "T\u0000", summary: null } },
  ]) {
    assert.equal(
      validateAiRequest(bad),
      null,
      JSON.stringify(bad)?.slice(0, 80),
    );
  }
});

test("proposals convert only to supported blocks and reject unsafe content", () => {
  const ok = proposalBlocksToVisual([
    { kind: "heading2", text: "Heading" },
    {
      kind: "paragraph",
      text: "A **bold** and [safe](https://example.invalid/a) line.",
    },
    { kind: "bullet", text: "One" },
    { kind: "number", text: "Two" },
    { kind: "quote", text: "Quoted" },
    { kind: "divider", text: "" },
  ]);
  assert.equal(ok.ok, true);
  assert.deepEqual(
    ok.blocks.map((block) => block.kind),
    ["h2", "p", "ul", "ol", "quote", "hr"],
  );
  for (const bad of [
    [{ kind: "paragraph", text: "[x](javascript:alert(1))" }],
    [{ kind: "paragraph", text: "# Smuggled heading" }],
    [{ kind: "paragraph", text: "two\nlines" }],
    [{ kind: "paragraph", text: "" }],
    [{ kind: "divider", text: "text" }],
    [
      {
        kind: "paragraph",
        text: "![img](https://example.invalid/i.png) inline",
      },
    ],
  ]) {
    assert.equal(proposalBlocksToVisual(bad).ok, false, JSON.stringify(bad));
  }
  const request = selection("rewrite");
  const base = {
    schema: 1,
    operation: "rewrite",
    title: null,
    blocks: [{ kind: "paragraph", text: "Fine" }],
  };
  assert.equal(validateAiProposal(base, request).ok, true);
  for (const bad of [
    { ...base, operation: "shorten" },
    { ...base, title: "No titles for edits" },
    { ...base, blocks: [] },
    { ...base, blocks: [base.blocks[0], base.blocks[0]] },
    { ...base, blocks: [{ kind: "divider", text: "" }] },
    { ...base, blocks: [{ kind: "table", text: "a" }] },
    { ...base, extra: true },
    { ...base, schema: 9 },
  ]) {
    assert.equal(
      validateAiProposal(bad, request).ok,
      false,
      JSON.stringify(bad),
    );
  }
});

test("the fixture provider answers every operation with valid blocks", async () => {
  const ai = service();
  for (const request of [
    selection("rewrite"),
    selection("shorten", "First sentence. Second sentence."),
    selection("change_tone", "A fictional paragraph.", "formal"),
    selection("translate", "A fictional paragraph.", "Spanish"),
    draft("create_outline"),
    draft("draft_section"),
    draft("draft_article"),
  ]) {
    const result = await ai.propose(request);
    assert.equal(result.status, "ok", request.operation);
    assert.equal(result.proposal.operation, request.operation);
  }
  const article = await ai.propose(draft("draft_article"));
  assert.ok(article.proposal.title);
  assert.match(
    article.proposal.blocks.map((block) => block.text).join(" "),
    /\[Needs (source|quote):/,
  );
  const shortened = await ai.propose(
    selection("shorten", "First sentence. Second sentence."),
  );
  assert.equal(shortened.proposal.blocks[0].text, "First sentence.");
});

test("refusals, malformed output, unsafe output, errors, timeouts and cancellation are typed failures", async () => {
  const ai = service({ timeoutMs: 80 });
  assert.equal(await ai.propose({ nope: true }), null);
  assert.equal(
    (await ai.propose(selection("rewrite", "[[refuse]]"))).status,
    "refused",
  );
  for (const marker of ["[[malformed]]", "[[bad-link]]", "[[bad-block]]"]) {
    const result = await ai.propose(selection("rewrite", marker));
    assert.equal(result.status, "invalid", marker);
    assert.ok(result.message.length > 0);
  }
  assert.equal(
    (await ai.propose(selection("rewrite", "[[error]]"))).status,
    "unavailable",
  );
  assert.equal(
    (await ai.propose(selection("rewrite", "[[slow]]"))).status,
    "timeout",
  );
  const controller = new AbortController();
  const pending = createAiProposalService({
    provider: createFixtureAiProvider(),
    timeoutMs: 5_000,
  }).propose(selection("rewrite", "[[slow]]"), controller.signal);
  setTimeout(() => controller.abort(), 10);
  assert.equal((await pending).status, "unavailable");
});

test("the OpenAI adapter sends a strict structured request and maps refusals and failures", async () => {
  const calls = [];
  const reply = (body, status = 200) =>
    new Response(JSON.stringify(body), { status });
  const provider = (respond) =>
    createOpenAiProvider({
      apiKey: "test-key-not-real",
      model: "test-model",
      fetch: async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        return respond();
      },
    });
  const proposal = {
    schema: 1,
    operation: "rewrite",
    title: null,
    blocks: [{ kind: "paragraph", text: "Rewritten" }],
  };
  const ok = await createAiProposalService({
    provider: provider(() =>
      reply({
        output: [
          {
            content: [{ type: "output_text", text: JSON.stringify(proposal) }],
          },
        ],
      }),
    ),
  }).propose(selection("rewrite"));
  assert.equal(ok.status, "ok");
  const sent = calls[0];
  assert.equal(sent.url, "https://api.openai.com/v1/responses");
  assert.equal(sent.init.headers.authorization, "Bearer test-key-not-real");
  assert.equal(sent.body.store, false);
  assert.equal(sent.body.model, "test-model");
  assert.equal(sent.body.text.format.type, "json_schema");
  assert.equal(sent.body.text.format.strict, true);
  assert.equal(
    JSON.stringify(sent.body.text.format.schema).includes("maxLength"),
    false,
  );
  assert.equal(JSON.stringify(sent.body).includes("test-key-not-real"), false);
  const refused = await createAiProposalService({
    provider: provider(() =>
      reply({ output: [{ content: [{ type: "refusal", refusal: "No." }] }] }),
    ),
  }).propose(selection("rewrite"));
  assert.deepEqual(refused, { status: "refused", message: "No." });
  const garbage = await createAiProposalService({
    provider: provider(() =>
      reply({
        output: [{ content: [{ type: "output_text", text: "not json" }] }],
      }),
    ),
  }).propose(selection("rewrite"));
  assert.equal(garbage.status, "invalid");
  const down = await createAiProposalService({
    provider: provider(() => reply({}, 500)),
  }).propose(selection("rewrite"));
  assert.equal(down.status, "unavailable");
});

test("providers come from server settings and stay off by default", () => {
  assert.equal(createAiProviderFromEnv({}), null);
  assert.equal(createAiProviderFromEnv({ AI_PROVIDER: "openai" }), null);
  assert.equal(
    createAiProviderFromEnv({ AI_PROVIDER: "openai", OPENAI_API_KEY: "k" }),
    null,
  );
  assert.equal(
    createAiProviderFromEnv({ AI_PROVIDER: "fixture" }).name,
    "fixture",
  );
  assert.equal(
    createAiProviderFromEnv({
      AI_PROVIDER: "openai",
      OPENAI_API_KEY: "k",
      AI_MODEL: "m",
    }).name,
    "openai",
  );
});

test("the transport requires an editing account, bounds input and returns typed results", async () => {
  const sandbox = await startSandbox({ aiTimeoutMs: 80 });
  try {
    const session = { account: "author" };
    const client = makeClient(sandbox, session);
    const ok = await client.proposeAi(selection("rewrite"));
    assert.equal(ok.status, "ok");
    assert.equal(
      (await client.proposeAi(selection("rewrite", "[[refuse]]"))).status,
      "refused",
    );
    assert.equal(
      (await client.proposeAi(selection("rewrite", "[[slow]]"))).status,
      "timeout",
    );
    await assert.rejects(
      () => client.proposeAi({ schema: 1, operation: "rewrite" }),
      (error) =>
        error instanceof EditorApiError && error.code === "invalid_request",
    );
    session.account = "readonly";
    await assert.rejects(
      () => client.proposeAi(selection("rewrite")),
      (error) => error instanceof EditorApiError && error.code === "forbidden",
    );
    session.account = "retired";
    await assert.rejects(
      () => client.proposeAi(selection("rewrite")),
      (error) => error instanceof EditorApiError,
    );
  } finally {
    sandbox.close();
  }
});
