// A deliberately small JSON Schema validator: exactly the keywords our schemas use.
// Taking a dependency for this would break the zero-dependency guarantee (D2), and a
// full validator would be far more code than the subset we actually need.

const KNOWN = new Set([
  '$schema', '$id', '$defs', '$ref', 'title', 'description', 'default', 'examples',
  'type', 'enum', 'const', 'required', 'properties', 'additionalProperties',
  'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum', 'propertyNames',
]);

/**
 * @returns {{path: string, message: string}[]} empty when valid
 */
export function validate(instance, schema, { root = schema, path = '' } = {}) {
  const errors = [];
  if (schema === true || schema === undefined) return errors;
  if (schema === false) return [{ path, message: 'schema forbids any value' }];

  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, root);
    if (!resolved) return [{ path, message: `unresolvable $ref ${schema.$ref}` }];
    return validate(instance, resolved, { root, path });
  }

  for (const key of Object.keys(schema)) {
    if (!KNOWN.has(key)) {
      errors.push({ path, message: `schema uses unsupported keyword "${key}"` });
    }
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => isType(instance, t))) {
      errors.push({ path, message: `expected ${types.join(' or ')}, got ${typeName(instance)}` });
      return errors; // further checks would be noise
    }
  }

  if (schema.enum !== undefined && !schema.enum.some((v) => deepEqual(v, instance))) {
    errors.push({ path, message: `must be one of: ${schema.enum.join(', ')}` });
  }
  if (schema.const !== undefined && !deepEqual(schema.const, instance)) {
    errors.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
  }

  if (typeof instance === 'string') {
    if (schema.minLength !== undefined && instance.length < schema.minLength) {
      errors.push({ path, message: `must be at least ${schema.minLength} characters (is ${instance.length})` });
    }
    if (schema.maxLength !== undefined && instance.length > schema.maxLength) {
      errors.push({ path, message: `must be at most ${schema.maxLength} characters (is ${instance.length})` });
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(instance)) {
      errors.push({ path, message: `"${truncate(instance)}" does not match ${schema.pattern}` });
    }
  }

  if (typeof instance === 'number') {
    if (schema.minimum !== undefined && instance < schema.minimum) {
      errors.push({ path, message: `must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && instance > schema.maximum) {
      errors.push({ path, message: `must be <= ${schema.maximum}` });
    }
  }

  if (Array.isArray(instance)) {
    if (schema.minItems !== undefined && instance.length < schema.minItems) {
      errors.push({ path, message: `needs at least ${schema.minItems} item(s)` });
    }
    if (schema.maxItems !== undefined && instance.length > schema.maxItems) {
      errors.push({ path, message: `allows at most ${schema.maxItems} item(s)` });
    }
    if (schema.items) {
      instance.forEach((item, i) => {
        errors.push(...validate(item, schema.items, { root, path: `${path}[${i}]` }));
      });
    }
  }

  if (isPlainObject(instance)) {
    for (const key of schema.required || []) {
      if (!(key in instance)) errors.push({ path, message: `missing required property "${key}"` });
    }
    const props = schema.properties || {};
    for (const [key, value] of Object.entries(instance)) {
      const childPath = path ? `${path}.${key}` : key;
      if (props[key] !== undefined) {
        errors.push(...validate(value, props[key], { root, path: childPath }));
      } else if (schema.additionalProperties === false) {
        errors.push({ path, message: `unknown property "${key}"` });
      } else if (isPlainObject(schema.additionalProperties)) {
        errors.push(...validate(value, schema.additionalProperties, { root, path: childPath }));
      }
      if (schema.propertyNames) {
        errors.push(...validate(key, schema.propertyNames, { root, path: `${childPath} (key)` }));
      }
    }
  }

  return errors;
}

function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) return null;
  let node = root;
  for (const seg of ref.slice(2).split('/')) {
    if (!node || typeof node !== 'object') return null;
    node = node[decodeURIComponent(seg.replace(/~1/g, '/').replace(/~0/g, '~'))];
  }
  return node;
}

function isType(v, t) {
  switch (t) {
    case 'object':
      return isPlainObject(v);
    case 'array':
      return Array.isArray(v);
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'null':
      return v === null;
    default:
      return false;
  }
}

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function truncate(s, n = 48) {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}
