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
    validate(parsed, schema);
  } catch (error) {
    throw new Error(
      `Claude did not return valid structured JSON: ${error.message}\n` +
        `Raw final message:\n${output}`,
      { cause: error },
    );
  }

  return renderReviewResult(parsed, targetLabel(target));
}

function validate(value, rule) {
  if (rule.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Expected an object.');

    for (const key of rule.required)
      if (!Object.hasOwn(value, key)) throw new Error(`Missing ${key}.`);

    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(rule.properties, key))
        throw new Error(`Unexpected field ${key}.`);

      validate(value[key], rule.properties[key]);
    }
  } else if (rule.type === 'array') {
    if (!Array.isArray(value)) throw new Error('Expected an array.');

    for (const item of value) validate(item, rule.items);
  } else validateScalar(value, rule);
}

function validateScalar(value, rule) {
  const type = rule.type === 'integer' ? 'number' : rule.type;
  if (typeof value !== type) throw new Error(`Expected ${rule.type}.`);

  if (rule.type === 'integer' && !Number.isInteger(value))
    throw new Error('Expected an integer.');

  if (rule.enum && !rule.enum.includes(value))
    throw new Error(`Expected one of ${rule.enum.join(', ')}.`);

  if (value < rule.minimum || value > rule.maximum)
    throw new Error('Value outside the allowed range.');

  if (value.length < rule.minLength) throw new Error('Empty string.');
}
