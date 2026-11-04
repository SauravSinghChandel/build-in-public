const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const string = { type: 'string' };
const strings = { type: 'array', items: string };
export const summarySchema = object({ summary: string });
export const nameSchema = object({ name: string });
export const xSchema = object({ x: object({ parts: { ...strings, minItems: 1, maxItems: 4 } }) });
export const postSchema = object({ ...xSchema.properties, linkedin: object({ text: string }), highlights: strings, claims_to_verify: strings });
