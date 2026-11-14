/**
 * A small OpenAPI 3.0 schema checker for tests (no dependency): it follows $ref, checks types,
 * nullable, enum, required properties, array items, oneOf/anyOf/allOf. Extra properties are allowed
 * (a generated client ignores them); a missing required field or a wrong type is an error.
 */
export interface OpenApiDoc {
  readonly openapi: string;
  readonly servers?: readonly { url: string }[];
  readonly paths: Record<string, Record<string, OperationObject>>;
  readonly components: {
    readonly schemas: Record<string, Schema>;
    readonly responses?: Record<string, ResponseObject>;
  };
}

interface ResponseObject {
  readonly $ref?: string;
  readonly content?: Record<string, { readonly schema?: Schema }>;
}

export interface OperationObject {
  readonly responses: Record<string, ResponseObject>;
}

export interface Schema {
  readonly $ref?: string;
  readonly type?: string;
  readonly nullable?: boolean;
  readonly enum?: readonly unknown[];
  readonly required?: readonly string[];
  readonly properties?: Record<string, Schema>;
  readonly items?: Schema;
  readonly oneOf?: readonly Schema[];
  readonly anyOf?: readonly Schema[];
  readonly allOf?: readonly Schema[];
}

function resolve(doc: OpenApiDoc, schema: Schema): Schema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.replace('#/components/schemas/', '');
  const target = doc.components.schemas[name];
  if (!target) throw new Error(`unknown $ref ${schema.$ref}`);
  return resolve(doc, target);
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/** The problems of `value` against `schema`, as "path: message" lines (empty when it conforms). */
export function check(doc: OpenApiDoc, input: Schema, value: unknown, path = '$'): string[] {
  const schema = resolve(doc, input);
  if (value === null && schema.nullable) return [];
  if (schema.allOf) return schema.allOf.flatMap((part) => check(doc, part, value, path));
  for (const options of [schema.oneOf, schema.anyOf]) {
    if (!options) continue;
    const results = options.map((option) => check(doc, option, value, path));
    if (results.some((problems) => problems.length === 0)) return [];
    return [`${path}: matches no alternative (${results.map((r) => r[0]).join(' | ')})`];
  }
  if (value === null) return [`${path}: null is not allowed`];
  if (schema.enum && !schema.enum.includes(value)) {
    return [`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`];
  }
  const actual = typeOf(value);
  const expected = schema.type ?? (schema.properties ? 'object' : undefined);
  if (expected && expected !== actual && !(expected === 'number' && actual === 'integer')) {
    return [`${path}: expected ${expected}, got ${actual}`];
  }
  if (actual === 'array' && schema.items) {
    const items = schema.items;
    return (value as unknown[]).flatMap((item, index) =>
      check(doc, items, item, `${path}[${index}]`),
    );
  }
  if (actual === 'object') {
    const object = value as Record<string, unknown>;
    const missing = (schema.required ?? [])
      .filter((key) => !(key in object))
      .map((key) => `${path}.${key}: required but missing`);
    const nested = Object.entries(schema.properties ?? {})
      .filter(([key]) => key in object)
      .flatMap(([key, property]) => check(doc, property, object[key], `${path}.${key}`));
    return [...missing, ...nested];
  }
  return [];
}

/**
 * Whether the document has the `status` answer of `method path`, and its JSON schema if it has a
 * JSON body. `undefined` when the operation or the status is not documented.
 */
export function documentedResponse(
  doc: OpenApiDoc,
  method: string,
  path: string,
  status: number,
): { readonly schema?: Schema } | undefined {
  const operation = doc.paths[path]?.[method.toLowerCase()];
  let response: ResponseObject | undefined =
    operation?.responses[String(status)] ?? operation?.responses.default;
  while (response?.$ref) {
    response = doc.components.responses?.[response.$ref.replace('#/components/responses/', '')];
  }
  if (!response) return undefined;
  return { schema: response.content?.['application/json']?.schema };
}
