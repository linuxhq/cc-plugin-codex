import { readFile } from 'node:fs/promises';
import { renderReviewResult } from './render.mjs';

export const schema = JSON.parse(
  await readFile(
    new URL('../../schemas/review-output.schema.json', import.meta.url),
    'utf8',
  ),
);

export function adversarialPrompt(template, target, focus) {
  const variables = {
    TARGET_LABEL: targetLabel(target),
    USER_FOCUS: focus || 'No extra focus provided.',
    REVIEW_COLLECTION_GUIDANCE: target.collectionGuidance,
    REVIEW_INPUT: target.context,
  };
  return {
    system:
      'Perform the adversarial review requested in the input. ' +
      `Return only JSON matching this schema:\n${JSON.stringify(schema)}`,
    input: template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => variables[key]),
  };
}

export function targetLabel(target) {
  return target.base
    ? `branch diff against ${target.base}`
    : 'working tree diff';
}

export function renderAdversarial(output, target) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    return renderReviewResult(null, targetLabel(target), output, error.message);
  }

  return renderReviewResult(parsed, targetLabel(target));
}
