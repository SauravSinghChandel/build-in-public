import Ajv from 'ajv';
import twitterText from 'twitter-text';
import { postSchema, xSchema } from './schemas.mjs';
const ajv = new Ajv({ allErrors: true });
export function validateSchema(schema, value) {
  const validate = ajv.compile(schema);
  return { valid: !!validate(value), errors: validate.errors ?? [] };
}
export function validateDraft(draft, xOnly = false) {
  const schema = validateSchema(xOnly ? xSchema : postSchema, draft);
  if (!schema.valid) return { valid: false, schema };
  const xLengths = draft.x.parts.map(p => twitterText.parseTweet(p).weightedLength);
  const xValid = draft.x.parts.every(p => twitterText.parseTweet(p).valid);
  const linkedinLength = xOnly ? null : Array.from(draft.linkedin.text).length;
  const text = [...draft.x.parts, ...(xOnly ? [] : [draft.linkedin.text])];
  const hashtagCounts = text.map(p => twitterText.extractHashtags(p).length);
  const hook = xOnly || (draft.linkedin.text.split('\n')[0].trim().length > 0 && draft.linkedin.text.includes('\n'));
  return { valid: xValid && (xOnly || linkedinLength >= 600 && linkedinLength <= 1200) && hashtagCounts.every(n => n <= 2) && hook,
    xLengths, linkedinLength, hashtagCounts, hook, schema };
}
