/**
 * A dependency-free JSON Schema validator (draft-07 compatible subset).
 *
 * Supported keywords:
 *   boolean schemas, $ref (local), $defs/definitions, type, enum, const,
 *   properties, patternProperties, additionalProperties, propertyNames,
 *   required, minProperties, maxProperties, dependencies,
 *   items (schema | tuple), additionalItems, prefixItems, minItems, maxItems,
 *   uniqueItems, contains,
 *   minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf,
 *   minLength, maxLength, pattern,
 *   allOf, anyOf, oneOf, not, if/then/else,
 *   format (date-time, date, time, email, uri, uuid, ipv4, ipv6),
 *   nullable (OpenAPI compatibility).
 */

export interface SchemaValidationError {
  /** JSON pointer to the offending instance location. */
  path: string;
  /** The schema keyword that failed. */
  keyword: string;
  /** Human readable description. */
  message: string;
  /** Additional context. */
  params?: Record<string, unknown>;
}

export interface ValidateOptions {
  /** Root document used to resolve local `$ref` pointers. */
  rootSchema?: Record<string, unknown>;
  /** Maximum number of errors collected. Defaults to 100. */
  maxErrors?: number;
}

type Schema = Record<string, unknown> | boolean;

const FORMAT_CHECKS: Record<string, (value: string) => boolean> = {
  'date-time': (v) => /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})?$/.test(v),
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v),
  time: (v) => /^\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})?$/.test(v),
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  uri: (v) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v),
  'uri-reference': () => true,
  uuid: (v) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v),
  ipv4: (v) => /^\d{1,3}(\.\d{1,3}){3}$/.test(v) && v.split('.').every((p) => Number(p) <= 255),
  ipv6: (v) => v.includes(':'),
  hostname: (v) => /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(v),
  regex: () => true,
};

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  switch (typeof value) {
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    default:
      return 'unknown';
  }
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  if (type === 'integer') return actual === 'integer';
  return actual === type;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as object).sort();
    const bKeys = Object.keys(b as object).sort();
    if (aKeys.length !== bKeys.length) return false;
    if (!aKeys.every((k, i) => k === bKeys[i])) return false;
    return aKeys.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Resolve a local JSON pointer (`#/path/to/thing`) against the root schema. */
export function resolveRef(ref: string, root: Record<string, unknown>): Schema | undefined {
  if (!ref.startsWith('#')) return undefined;
  const pointer = ref.slice(1);
  if (pointer === '' || pointer === '/') return root;
  if (!pointer.startsWith('/')) return undefined;
  let current: unknown = root;
  for (const rawSegment of pointer.split('/').slice(1)) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) return undefined;
  }
  return current as Schema;
}

/** Validate a value against a JSON schema. Returns all detected errors. */
export function validateJsonSchema(
  value: unknown,
  schema: Schema,
  options: ValidateOptions = {},
): SchemaValidationError[] {
  const root = options.rootSchema ?? (typeof schema === 'object' ? (schema as Record<string, unknown>) : {});
  const errors: SchemaValidationError[] = [];
  const maxErrors = options.maxErrors ?? 100;

  const walk = (val: unknown, sch: Schema, path: string): void => {
    if (errors.length >= maxErrors) return;

    if (sch === true) return;
    if (sch === false) {
      errors.push({ path, keyword: 'false', message: 'no value is allowed here' });
      return;
    }
    if (typeof sch !== 'object' || sch === null) return;

    if (typeof sch.$ref === 'string') {
      const resolved = resolveRef(sch.$ref, root);
      if (!resolved) {
        errors.push({ path, keyword: '$ref', message: `cannot resolve reference "${sch.$ref}"` });
        return;
      }
      walk(val, resolved, path);
      // draft-07 allows sibling keywords next to $ref; keep validating them.
    }

    if (sch.nullable === true && val === null) return;

    if (sch.type !== undefined) {
      const types = Array.isArray(sch.type) ? (sch.type as string[]) : [sch.type as string];
      if (!types.some((t) => matchesType(val, t))) {
        errors.push({
          path,
          keyword: 'type',
          message: `expected type ${types.join(' | ')} but received ${typeOf(val)}`,
          params: { expected: types, actual: typeOf(val) },
        });
        return; // further keyword checks would be noise
      }
    }

    if (Array.isArray(sch.enum)) {
      if (!sch.enum.some((option) => deepEqual(option, val))) {
        errors.push({
          path,
          keyword: 'enum',
          message: `value must be one of ${JSON.stringify(sch.enum)}`,
          params: { allowed: sch.enum },
        });
      }
    }

    if ('const' in sch && !deepEqual(sch.const, val)) {
      errors.push({
        path,
        keyword: 'const',
        message: `value must equal ${JSON.stringify(sch.const)}`,
        params: { expected: sch.const },
      });
    }

    // ---- strings -----------------------------------------------------------
    if (typeof val === 'string') {
      if (typeof sch.minLength === 'number' && val.length < sch.minLength) {
        errors.push({
          path,
          keyword: 'minLength',
          message: `string length ${val.length} is shorter than minLength ${sch.minLength}`,
        });
      }
      if (typeof sch.maxLength === 'number' && val.length > sch.maxLength) {
        errors.push({
          path,
          keyword: 'maxLength',
          message: `string length ${val.length} is longer than maxLength ${sch.maxLength}`,
        });
      }
      if (typeof sch.pattern === 'string') {
        let re: RegExp | undefined;
        try {
          re = new RegExp(sch.pattern, 'u');
        } catch {
          try {
            re = new RegExp(sch.pattern);
          } catch {
            re = undefined;
          }
        }
        if (re && !re.test(val)) {
          errors.push({
            path,
            keyword: 'pattern',
            message: `string does not match pattern ${sch.pattern}`,
          });
        }
      }
      if (typeof sch.format === 'string') {
        const check = FORMAT_CHECKS[sch.format];
        if (check && !check(val)) {
          errors.push({
            path,
            keyword: 'format',
            message: `string is not a valid ${sch.format}`,
          });
        }
      }
    }

    // ---- numbers -----------------------------------------------------------
    if (typeof val === 'number') {
      if (typeof sch.minimum === 'number' && val < sch.minimum) {
        errors.push({
          path,
          keyword: 'minimum',
          message: `value ${val} is less than minimum ${sch.minimum}`,
        });
      }
      if (typeof sch.maximum === 'number' && val > sch.maximum) {
        errors.push({
          path,
          keyword: 'maximum',
          message: `value ${val} is greater than maximum ${sch.maximum}`,
        });
      }
      if (typeof sch.exclusiveMinimum === 'number' && val <= sch.exclusiveMinimum) {
        errors.push({
          path,
          keyword: 'exclusiveMinimum',
          message: `value ${val} must be greater than ${sch.exclusiveMinimum}`,
        });
      }
      if (typeof sch.exclusiveMaximum === 'number' && val >= sch.exclusiveMaximum) {
        errors.push({
          path,
          keyword: 'exclusiveMaximum',
          message: `value ${val} must be less than ${sch.exclusiveMaximum}`,
        });
      }
      if (typeof sch.multipleOf === 'number' && sch.multipleOf > 0) {
        const quotient = val / sch.multipleOf;
        if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
          errors.push({
            path,
            keyword: 'multipleOf',
            message: `value ${val} is not a multiple of ${sch.multipleOf}`,
          });
        }
      }
    }

    // ---- arrays ------------------------------------------------------------
    if (Array.isArray(val)) {
      if (typeof sch.minItems === 'number' && val.length < sch.minItems) {
        errors.push({
          path,
          keyword: 'minItems',
          message: `array has ${val.length} items, fewer than minItems ${sch.minItems}`,
        });
      }
      if (typeof sch.maxItems === 'number' && val.length > sch.maxItems) {
        errors.push({
          path,
          keyword: 'maxItems',
          message: `array has ${val.length} items, more than maxItems ${sch.maxItems}`,
        });
      }
      if (sch.uniqueItems === true) {
        const seen: string[] = [];
        for (const item of val) {
          const key = JSON.stringify(item);
          if (seen.includes(key)) {
            errors.push({
              path,
              keyword: 'uniqueItems',
              message: `array contains a duplicate item: ${key}`,
            });
            break;
          }
          seen.push(key);
        }
      }

      const tuple = Array.isArray(sch.items) ? (sch.items as Schema[]) : undefined;
      if (tuple) {
        tuple.forEach((itemSchema, index) => {
          const item = val[index];
          if (item !== undefined) {
            walk(item, itemSchema, `${path}/${index}`);
          }
        });
        if (sch.additionalItems !== undefined && val.length > tuple.length) {
          const rest = val.slice(tuple.length);
          if (sch.additionalItems === false) {
            errors.push({
              path,
              keyword: 'additionalItems',
              message: `array has ${rest.length} extra items that are not allowed`,
            });
          } else if (typeof sch.additionalItems === 'object') {
            rest.forEach((item, i) => {
              walk(item, sch.additionalItems as Schema, `${path}/${tuple.length + i}`);
            });
          }
        }
      } else if (sch.items !== undefined) {
        const itemSchema = sch.items as Schema;
        val.forEach((item, index) => {
          walk(item, itemSchema, `${path}/${index}`);
        });
      }

      if (sch.prefixItems !== undefined && Array.isArray(sch.prefixItems)) {
        (sch.prefixItems as Schema[]).forEach((itemSchema, index) => {
          const item = val[index];
          if (item !== undefined) walk(item, itemSchema, `${path}/${index}`);
        });
      }

      if (sch.contains !== undefined) {
        const containsSchema = sch.contains as Schema;
        const matched = val.some((item) => validateJsonSchema(item, containsSchema, { rootSchema: root }).length === 0);
        if (!matched) {
          errors.push({
            path,
            keyword: 'contains',
            message: 'no array item matches the "contains" schema',
          });
        }
      }
    }

    // ---- objects -----------------------------------------------------------
    if (typeOf(val) === 'object' && val !== null && !Array.isArray(val)) {
      const obj = val as Record<string, unknown>;
      const keys = Object.keys(obj);

      if (Array.isArray(sch.required)) {
        for (const key of sch.required as string[]) {
          if (!Object.prototype.hasOwnProperty.call(obj, key)) {
            errors.push({
              path,
              keyword: 'required',
              message: `missing required property "${key}"`,
              params: { property: key },
            });
          }
        }
      }

      if (typeof sch.minProperties === 'number' && keys.length < sch.minProperties) {
        errors.push({
          path,
          keyword: 'minProperties',
          message: `object has ${keys.length} properties, fewer than minProperties ${sch.minProperties}`,
        });
      }
      if (typeof sch.maxProperties === 'number' && keys.length > sch.maxProperties) {
        errors.push({
          path,
          keyword: 'maxProperties',
          message: `object has ${keys.length} properties, more than maxProperties ${sch.maxProperties}`,
        });
      }

      const properties = (sch.properties ?? {}) as Record<string, Schema>;
      const patternProperties = (sch.patternProperties ?? {}) as Record<string, Schema>;

      for (const key of keys) {
        const childPath = `${path}/${escapePointer(key)}`;
        let matched = false;

        if (Object.prototype.hasOwnProperty.call(properties, key)) {
          matched = true;
          walk(obj[key], properties[key] as Schema, childPath);
        }

        for (const [pattern, patternSchema] of Object.entries(patternProperties)) {
          let re: RegExp | undefined;
          try {
            re = new RegExp(pattern, 'u');
          } catch {
            re = new RegExp(pattern);
          }
          if (re && re.test(key)) {
            matched = true;
            walk(obj[key], patternSchema, childPath);
          }
        }

        if (!matched && sch.additionalProperties !== undefined) {
          if (sch.additionalProperties === false) {
            errors.push({
              path: childPath,
              keyword: 'additionalProperties',
              message: `additional property "${key}" is not allowed`,
              params: { property: key },
            });
          } else if (typeof sch.additionalProperties === 'object') {
            walk(obj[key], sch.additionalProperties as Schema, childPath);
          }
        }
      }

      if (sch.propertyNames !== undefined) {
        for (const key of keys) {
          const nameErrors = validateJsonSchema(key, sch.propertyNames as Schema, { rootSchema: root });
          for (const err of nameErrors) {
            errors.push({
              path: `${path}/${escapePointer(key)}`,
              keyword: 'propertyNames',
              message: `property name "${key}" is invalid: ${err.message}`,
            });
          }
        }
      }

      if (sch.dependencies && typeof sch.dependencies === 'object') {
        for (const [key, dependency] of Object.entries(sch.dependencies as Record<string, unknown>)) {
          if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
          if (Array.isArray(dependency)) {
            for (const requiredKey of dependency) {
              if (!Object.prototype.hasOwnProperty.call(obj, requiredKey)) {
                errors.push({
                  path,
                  keyword: 'dependencies',
                  message: `property "${key}" requires "${requiredKey}"`,
                });
              }
            }
          } else if (dependency && typeof dependency === 'object') {
            walk(val, dependency as Schema, path);
          }
        }
      }
    }

    // ---- combinators -------------------------------------------------------
    if (Array.isArray(sch.allOf)) {
      (sch.allOf as Schema[]).forEach((sub, index) => {
        walk(val, sub, path);
        void index;
      });
    }

    if (Array.isArray(sch.anyOf)) {
      const branches = sch.anyOf as Schema[];
      const ok = branches.some(
        (sub) => validateJsonSchema(val, sub, { rootSchema: root }).length === 0,
      );
      if (!ok) {
        errors.push({
          path,
          keyword: 'anyOf',
          message: `value does not match any of the ${branches.length} allowed schemas`,
        });
      }
    }

    if (Array.isArray(sch.oneOf)) {
      const branches = sch.oneOf as Schema[];
      const matches = branches.filter(
        (sub) => validateJsonSchema(val, sub, { rootSchema: root }).length === 0,
      );
      if (matches.length === 0) {
        errors.push({
          path,
          keyword: 'oneOf',
          message: `value does not match any of the ${branches.length} allowed schemas`,
        });
      } else if (matches.length > 1) {
        errors.push({
          path,
          keyword: 'oneOf',
          message: `value matches ${matches.length} schemas, expected exactly one`,
        });
      }
    }

    if (sch.not !== undefined) {
      const subErrors = validateJsonSchema(val, sch.not as Schema, { rootSchema: root });
      if (subErrors.length === 0) {
        errors.push({ path, keyword: 'not', message: 'value must not match the "not" schema' });
      }
    }

    if (sch.if !== undefined) {
      const ifErrors = validateJsonSchema(val, sch.if as Schema, { rootSchema: root });
      const branch = ifErrors.length === 0 ? sch.then : sch.else;
      if (branch !== undefined) walk(val, branch as Schema, path);
    }
  };

  walk(value, schema, '');
  return errors;
}

/** Format schema errors into a single readable line. */
export function formatSchemaErrors(errors: SchemaValidationError[]): string {
  if (errors.length === 0) return 'no errors';
  return errors
    .map((err) => {
      const location = err.path === '' ? '(root)' : err.path;
      return `${location}: ${err.message}`;
    })
    .join('; ');
}
