import type { AssertionResult, LlmJudgeAssertion } from '../../core/types.js';
import type { AssertionContext, AssertionValidator } from './types.js';
import { extractJson } from './jsonExtract.js';
import { renderTemplate } from '../template.js';

export const DEFAULT_JUDGE_SYSTEM_PROMPT =
  'You are an expert evaluation judge. You evaluate an AI model output against a given evaluation rubric.\n' +
  'Respond ONLY with a valid JSON object matching this schema:\n' +
  '{\n' +
  '  "score": <number between 0.0 and 1.0>,\n' +
  '  "reasoning": "<clear, concise explanation of the verdict>"\n' +
  '}';

export const DEFAULT_JUDGE_USER_TEMPLATE =
  'Prompt Given to Model:\n"""\n{{prompt}}\n"""\n\n' +
  'Model Output to Evaluate:\n"""\n{{output}}\n"""\n\n' +
  'Evaluation Rubric:\n"""\n{{rubric}}\n"""\n\n' +
  'Evaluate the output strictly against the rubric.\n' +
  'Assign a score between 0.0 (completely fails) and 1.0 (perfectly satisfies).\n' +
  'Output your JSON verdict now.';

export const validateLlmJudge: AssertionValidator = async (
  rawAssertion,
  context: AssertionContext,
): Promise<AssertionResult> => {
  const assertion = rawAssertion as LlmJudgeAssertion;
  const name = assertion.name ?? 'llm-judge';
  const startedAt = performance.now();
  const minScore = assertion.minScore ?? 0.7;

  if (!context.judge) {
    return {
      name,
      type: 'llm-judge',
      status: 'failed',
      passed: false,
      score: 0,
      expected: `>= ${minScore}`,
      actual: 0,
      message:
        'No judge provider is configured or available to evaluate this llm-judge assertion. Configure "judge" in prompt-guard.config.json or specify a judge provider.',
      durationMs: performance.now() - startedAt,
    };
  }

  // Get raw prompt from fixture
  const promptText =
    typeof context.fixture.prompt === 'string'
      ? context.fixture.prompt
      : context.fixture.prompt.map((m) => m.content).join('\n');

  const renderedPrompt = renderTemplate(promptText, context.variables).text;
  const renderedRubric = renderTemplate(assertion.rubric, context.variables).text;

  const judgeUserPrompt = renderTemplate(
    assertion.promptTemplate ?? DEFAULT_JUDGE_USER_TEMPLATE,
    {
      prompt: renderedPrompt,
      output: context.output,
      rubric: renderedRubric,
    },
  ).text;

  try {
    const judgeRawResponse = await context.judge({
      prompt: judgeUserPrompt,
      system: DEFAULT_JUDGE_SYSTEM_PROMPT,
      provider: assertion.provider,
      model: assertion.model,
    });

    const parsed = extractJson(judgeRawResponse, 'auto');
    const data = parsed.value as Record<string, unknown>;

    let score = 0;
    if (typeof data.score === 'number' && !Number.isNaN(data.score)) {
      score = Math.max(0, Math.min(1, data.score));
    } else if (typeof data.score === 'string') {
      const parsedNum = parseFloat(data.score);
      if (!Number.isNaN(parsedNum)) {
        score = Math.max(0, Math.min(1, parsedNum));
      }
    }

    const reasoning =
      typeof data.reasoning === 'string' && data.reasoning.trim().length > 0
        ? data.reasoning.trim()
        : 'No reasoning provided by judge.';

    const passed = score >= minScore;

    return {
      name,
      type: 'llm-judge',
      status: passed ? 'passed' : 'failed',
      passed,
      score,
      expected: `>= ${minScore}`,
      actual: score,
      message: `[Score: ${score.toFixed(2)} / ${minScore.toFixed(2)}] ${reasoning}`,
      durationMs: performance.now() - startedAt,
      details: {
        score,
        minScore,
        reasoning,
        judgeResponse: judgeRawResponse,
      },
    };
  } catch (err) {
    return {
      name,
      type: 'llm-judge',
      status: 'errored',
      passed: false,
      score: 0,
      expected: `>= ${minScore}`,
      actual: 0,
      message: `Judge evaluation failed: ${(err as Error).message}`,
      durationMs: performance.now() - startedAt,
    };
  }
};
