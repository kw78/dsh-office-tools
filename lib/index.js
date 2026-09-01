// node_modules/.pnpm/@deepseek-ai+cosmokit@1.8.3/node_modules/@deepseek-ai/cosmokit/lib/index.js
function isNullable(value) {
  return value === null || value === void 0;
}
function isPlainObject(data) {
  return data && typeof data === "object" && !Array.isArray(data);
}
function filterKeys(object, filter) {
  return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
}
function mapValues(object, transform) {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
}
function pick(source, keys, forced) {
  if (!keys) return { ...source };
  const result = {};
  for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
  return result;
}
function is(type, value) {
  if (arguments.length === 1) return (value2) => is(type, value2);
  return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike(value) {
  return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
}
function isArrayBufferSource(value) {
  return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}
var Binary;
(function(Binary2) {
  Binary2.is = isArrayBufferLike;
  Binary2.isSource = isArrayBufferSource;
  function fromSource(source) {
    if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    else return source;
  }
  Binary2.fromSource = fromSource;
  function toBase64(source) {
    source = fromSource(source);
    if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
    let binary = "";
    const bytes = new Uint8Array(source);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  Binary2.toBase64 = toBase64;
  function fromBase64(source) {
    if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
    return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
  }
  Binary2.fromBase64 = fromBase64;
  function toHex(source) {
    source = fromSource(source);
    if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
    return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  Binary2.toHex = toHex;
  function fromHex(source) {
    if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
    const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
    const buffer = [];
    for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
    return Uint8Array.from(buffer).buffer;
  }
  Binary2.fromHex = fromHex;
})(Binary || (Binary = {}));
var base64ToArrayBuffer = Binary.fromBase64;
var arrayBufferToBase64 = Binary.toBase64;
var hexToArrayBuffer = Binary.fromHex;
var arrayBufferToHex = Binary.toHex;
function clone(source, refs = /* @__PURE__ */ new Map()) {
  if (!source || typeof source !== "object") return source;
  if (is("Date", source)) return new Date(source.valueOf());
  if (is("RegExp", source)) return new RegExp(source.source, source.flags);
  if (isArrayBufferLike(source)) return source.slice(0);
  if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
  const cached = refs.get(source);
  if (cached) return cached;
  if (Array.isArray(source)) {
    const result2 = [];
    refs.set(source, result2);
    source.forEach((value, index) => {
      result2[index] = Reflect.apply(clone, null, [value, refs]);
    });
    return result2;
  }
  const result = Object.create(Object.getPrototypeOf(source));
  refs.set(source, result);
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
    if ("value" in descriptor) descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
    Reflect.defineProperty(result, key, descriptor);
  }
  return result;
}
function deepEqual(a, b, strict) {
  if (a === b) return true;
  if (!strict && isNullable(a) && isNullable(b)) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (!a || !b) return false;
  function check(test, then) {
    return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : void 0;
  }
  return check(Array.isArray, (a2, b2) => a2.length === b2.length && a2.every((item, index) => deepEqual(item, b2[index]))) ?? check(is("Date"), (a2, b2) => a2.valueOf() === b2.valueOf()) ?? check(is("RegExp"), (a2, b2) => a2.source === b2.source && a2.flags === b2.flags) ?? check(isArrayBufferLike, (a2, b2) => {
    if (a2.byteLength !== b2.byteLength) return false;
    const viewA = new Uint8Array(a2);
    const viewB = new Uint8Array(b2);
    for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
    return true;
  }) ?? Object.keys({
    ...a,
    ...b
  }).every((key) => deepEqual(a[key], b[key], strict));
}
var Time;
(function(Time2) {
  Time2.millisecond = 1;
  Time2.second = 1e3;
  Time2.minute = Time2.second * 60;
  Time2.hour = Time2.minute * 60;
  Time2.day = Time2.hour * 24;
  Time2.week = Time2.day * 7;
  let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
  function setTimezoneOffset(offset) {
    timezoneOffset = offset;
  }
  Time2.setTimezoneOffset = setTimezoneOffset;
  function getTimezoneOffset() {
    return timezoneOffset;
  }
  Time2.getTimezoneOffset = getTimezoneOffset;
  function getDateNumber(date2 = /* @__PURE__ */ new Date(), offset) {
    if (typeof date2 === "number") date2 = new Date(date2);
    if (offset === void 0) offset = timezoneOffset;
    return Math.floor((date2.valueOf() / Time2.minute - offset) / 1440);
  }
  Time2.getDateNumber = getDateNumber;
  function fromDateNumber(value, offset) {
    const date2 = new Date(value * Time2.day);
    if (offset === void 0) offset = timezoneOffset;
    return new Date(+date2 + offset * Time2.minute);
  }
  Time2.fromDateNumber = fromDateNumber;
  const numeric = /\d+(?:\.\d+)?/.source;
  const timeRegExp = new RegExp(`^${[
    "w(?:eek(?:s)?)?",
    "d(?:ay(?:s)?)?",
    "h(?:our(?:s)?)?",
    "m(?:in(?:ute)?(?:s)?)?",
    "s(?:ec(?:ond)?(?:s)?)?"
  ].map((unit) => `(${numeric}${unit})?`).join("")}$`);
  function parseTime(source) {
    const capture = timeRegExp.exec(source);
    if (!capture) return 0;
    return (parseFloat(capture[1]) * Time2.week || 0) + (parseFloat(capture[2]) * Time2.day || 0) + (parseFloat(capture[3]) * Time2.hour || 0) + (parseFloat(capture[4]) * Time2.minute || 0) + (parseFloat(capture[5]) * Time2.second || 0);
  }
  Time2.parseTime = parseTime;
  function parseDate(date2) {
    const parsed = parseTime(date2);
    if (parsed) date2 = Date.now() + parsed;
    else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date2)) date2 = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date2}`;
    else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date2)) date2 = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date2}`;
    return date2 ? new Date(date2) : /* @__PURE__ */ new Date();
  }
  Time2.parseDate = parseDate;
  function format(ms) {
    const abs = Math.abs(ms);
    if (abs >= Time2.day - Time2.hour / 2) return Math.round(ms / Time2.day) + "d";
    else if (abs >= Time2.hour - Time2.minute / 2) return Math.round(ms / Time2.hour) + "h";
    else if (abs >= Time2.minute - Time2.second / 2) return Math.round(ms / Time2.minute) + "m";
    else if (abs >= Time2.second) return Math.round(ms / Time2.second) + "s";
    return ms + "ms";
  }
  Time2.format = format;
  function toDigits(source, length = 2) {
    return source.toString().padStart(length, "0");
  }
  Time2.toDigits = toDigits;
  function template(template2, time = /* @__PURE__ */ new Date()) {
    return template2.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
  }
  Time2.template = template;
})(Time || (Time = {}));

// node_modules/.pnpm/@deepseek-ai+schemastery@3.18.2/node_modules/@deepseek-ai/schemastery/lib/index.mjs
var kSchema = Symbol.for("schemastery");
var kValidationError = Symbol.for("ValidationError");
globalThis.__schemastery_index__ ??= 0;
globalThis.__schemastery_refs__ = void 0;
var ValidationError = class extends TypeError {
  options;
  name = "ValidationError";
  constructor(message, options) {
    let prefix = "$";
    for (const segment of options.path || []) if (typeof segment === "string") prefix += "." + segment;
    else if (typeof segment === "number") prefix += "[" + segment + "]";
    else if (typeof segment === "symbol") prefix += `[Symbol(${segment.toString()})]`;
    if (prefix.startsWith(".")) prefix = prefix.slice(1);
    super((prefix === "$" ? "" : `${prefix} `) + message);
    this.options = options;
  }
  static is(error) {
    return !!error?.[kValidationError];
  }
};
Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
var Schema = function(options) {
  const schema = function(data, options2 = {}) {
    return Schema.resolve(data, schema, options2)[0];
  };
  if (options.refs) {
    const refs = mapValues(options.refs, (options2) => new Schema(options2));
    const getRef = (uid) => refs[uid];
    for (const key in refs) {
      const options2 = refs[key];
      options2.sKey = getRef(options2.sKey);
      options2.inner = getRef(options2.inner);
      options2.list = options2.list && options2.list.map(getRef);
      options2.dict = options2.dict && mapValues(options2.dict, getRef);
    }
    return refs[options.uid];
  }
  Object.assign(schema, options);
  if (typeof schema.callback === "string") try {
    schema.callback = new Function("return " + schema.callback)();
  } catch {
  }
  Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
  Object.setPrototypeOf(schema, Schema.prototype);
  schema.meta ||= {};
  schema.toString = schema.toString.bind(schema);
  return schema;
};
Schema.prototype = Object.create(Function.prototype);
Schema.prototype[kSchema] = true;
Object.defineProperty(Schema.prototype, "~standard", { get() {
  return {
    version: 1,
    vendor: "schemastery",
    validate: (value) => {
      try {
        return { value: Schema.resolve(value, this, {})[0] };
      } catch (error) {
        if (ValidationError.is(error)) return { issues: [{
          message: error.message,
          path: error.options.path
        }] };
        throw error;
      }
    }
  };
} });
Schema.ValidationError = ValidationError;
Schema.prototype.toJSON = function toJSON() {
  if (globalThis.__schemastery_refs__) {
    globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
    return this.uid;
  }
  globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
  globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
  const result = {
    uid: this.uid,
    refs: globalThis.__schemastery_refs__
  };
  globalThis.__schemastery_refs__ = void 0;
  return result;
};
Schema.prototype.set = function set(key, value) {
  this.dict[key] = value;
  return this;
};
Schema.prototype.push = function push(value) {
  this.list.push(value);
  return this;
};
function mergeDesc(original, messages) {
  const result = typeof original === "string" ? { "": original } : { ...original };
  for (const locale in messages) {
    const value = messages[locale];
    if (value?.$description || value?.$desc) result[locale] = value.$description || value.$desc;
    else if (typeof value === "string") result[locale] = value;
  }
  return result;
}
function getInner(value) {
  return value?.$value ?? value?.$inner;
}
function extractKeys(data) {
  return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
}
Schema.prototype.i18n = function i18n(messages) {
  const schema = Schema(this);
  const desc = mergeDesc(schema.meta.description, messages);
  if (Object.keys(desc).length) schema.meta.description = desc;
  if (schema.dict) schema.dict = mapValues(schema.dict, (inner, key) => {
    return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
  });
  if (schema.list) schema.list = schema.list.map((inner, index) => {
    return inner.i18n(mapValues(messages, (data = {}) => {
      if (Array.isArray(getInner(data))) return getInner(data)[index];
      if (Array.isArray(data)) return data[index];
      return extractKeys(data);
    }));
  });
  if (schema.inner) schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
    if (getInner(data)) return getInner(data);
    return extractKeys(data);
  }));
  if (schema.sKey) schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
  return schema;
};
Schema.prototype.extra = function extra(key, value) {
  const schema = Schema(this);
  schema.meta = {
    ...schema.meta,
    [key]: value
  };
  return schema;
};
for (const key of [
  "required",
  "disabled",
  "collapse",
  "hidden",
  "loose"
]) Object.assign(Schema.prototype, { [key](value = true) {
  const schema = Schema(this);
  schema.meta = {
    ...schema.meta,
    [key]: value
  };
  return schema;
} });
Schema.prototype.deprecated = function deprecated() {
  const schema = Schema(this);
  schema.meta.badges ||= [];
  schema.meta.badges.push({
    text: "deprecated",
    type: "danger"
  });
  return schema;
};
Schema.prototype.experimental = function experimental() {
  const schema = Schema(this);
  schema.meta.badges ||= [];
  schema.meta.badges.push({
    text: "experimental",
    type: "warning"
  });
  return schema;
};
Schema.prototype.pattern = function pattern(regexp) {
  const schema = Schema(this);
  const pattern2 = pick(regexp, ["source", "flags"]);
  schema.meta = {
    ...schema.meta,
    pattern: pattern2
  };
  return schema;
};
Schema.prototype.simplify = function simplify(value) {
  if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
  if (isNullable(value)) return value;
  if (this.type === "object" || this.type === "dict") {
    const result = {};
    for (const key in value) {
      const item = (this.type === "object" ? this.dict[key] : this.inner)?.simplify(value[key]);
      if (this.type === "dict" || !isNullable(item)) result[key] = item;
    }
    if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
    return result;
  } else if (this.type === "array" || this.type === "tuple") {
    const result = [];
    value.forEach((value2, index) => {
      const schema = this.type === "array" ? this.inner : this.list[index];
      const item = schema ? schema.simplify(value2) : value2;
      result.push(item);
    });
    return result;
  } else if (this.type === "intersect") {
    const result = {};
    for (const item of this.list) Object.assign(result, item.simplify(value));
    return result;
  } else if (this.type === "union") for (const schema of this.list) try {
    Schema.resolve(value, schema, {});
    return schema.simplify(value);
  } catch {
  }
  return value;
};
Schema.prototype.toString = function toString(inline) {
  return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
};
Schema.prototype.role = function role(role, extra2) {
  const schema = Schema(this);
  schema.meta = {
    ...schema.meta,
    role,
    extra: extra2
  };
  return schema;
};
for (const key of [
  "default",
  "link",
  "comment",
  "description",
  "max",
  "min",
  "step"
]) Object.assign(Schema.prototype, { [key](value) {
  const schema = Schema(this);
  schema.meta = {
    ...schema.meta,
    [key]: value
  };
  return schema;
} });
var resolvers = {};
Schema.extend = function extend(type, resolve3) {
  resolvers[type] = resolve3;
};
Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
  if (!schema) return [data];
  if (options.ignore?.(data, schema)) return [data];
  if (isNullable(data) && schema.type !== "lazy") {
    if (schema.meta.required) throw new ValidationError(`missing required value`, options);
    let current = schema;
    let fallback = schema.meta.default;
    while (current?.type === "intersect" && isNullable(fallback)) {
      current = current.list[0];
      fallback = current?.meta.default;
    }
    if (isNullable(fallback)) return [data];
    data = clone(fallback);
  }
  const callback = resolvers[schema.type];
  if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options);
  try {
    return callback(data, schema, options, strict);
  } catch (error) {
    if (!schema.meta.loose) throw error;
    return [schema.meta.default];
  }
};
Schema.from = function from(source) {
  if (isNullable(source)) return Schema.any();
  else if ([
    "string",
    "number",
    "boolean"
  ].includes(typeof source)) return Schema.const(source).required();
  else if (source[kSchema]) return source;
  else if (typeof source === "function") switch (source) {
    case String:
      return Schema.string().required();
    case Number:
      return Schema.number().required();
    case Boolean:
      return Schema.boolean().required();
    case Function:
      return Schema.function().required();
    default:
      return Schema.is(source).required();
  }
  else throw new TypeError(`cannot infer schema from ${source}`);
};
Schema.lazy = function lazy(builder) {
  const toJSON2 = () => {
    if (!schema.inner[kSchema]) {
      schema.inner = schema.builder();
      schema.inner.meta = {
        ...schema.meta,
        ...schema.inner.meta
      };
    }
    return schema.inner.toJSON();
  };
  const schema = new Schema({
    type: "lazy",
    builder,
    inner: { toJSON: toJSON2 }
  });
  return schema;
};
Schema.natural = function natural() {
  return Schema.number().step(1).min(0);
};
Schema.percent = function percent() {
  return Schema.number().step(0.01).min(0).max(1).role("slider");
};
Schema.date = function date() {
  return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
    const date2 = new Date(value);
    if (isNaN(+date2)) throw new ValidationError(`invalid date "${value}"`, options);
    return date2;
  }, true)]);
};
Schema.regExp = function regExp(flag = "") {
  return Schema.union([Schema.is(RegExp), Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
    try {
      return new RegExp(value, flag);
    } catch (e) {
      throw new ValidationError(e.message, options);
    }
  }, true)]);
};
Schema.arrayBuffer = function arrayBuffer(encoding) {
  return Schema.union([
    Schema.is(ArrayBuffer),
    Schema.is(SharedArrayBuffer),
    Schema.transform(Schema.any(), (value, options) => {
      if (Binary.isSource(value)) return Binary.fromSource(value);
      throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options);
    }, true),
    ...encoding ? [Schema.transform(Schema.string(), (value, options) => {
      try {
        return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
      } catch (e) {
        throw new ValidationError(e.message, options);
      }
    }, true)] : []
  ]);
};
Schema.extend("lazy", (data, schema, options, strict) => {
  if (!schema.inner[kSchema]) {
    schema.inner = schema.builder();
    schema.inner.meta = {
      ...schema.meta,
      ...schema.inner.meta
    };
  }
  return Schema.resolve(data, schema.inner, options, strict);
});
Schema.extend("any", (data) => {
  return [data];
});
Schema.extend("never", (data, _, options) => {
  throw new ValidationError(`expected nullable but got ${data}`, options);
});
Schema.extend("const", (data, { value }, options) => {
  if (deepEqual(data, value)) return [value];
  throw new ValidationError(`expected ${value} but got ${data}`, options);
});
function checkWithinRange(data, meta, description, options, skipMin = false) {
  const { max = Infinity, min = -Infinity } = meta;
  if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
  if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
}
Schema.extend("string", (data, { meta }, options) => {
  if (typeof data !== "string") throw new ValidationError(`expected string but got ${data}`, options);
  if (meta.pattern) {
    const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
    if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options);
  }
  checkWithinRange(data.length, meta, "string length", options);
  return [data];
});
function decimalShift(data, digits) {
  const str = data.toString();
  if (str.includes("e")) return data * Math.pow(10, digits);
  const index = str.indexOf(".");
  if (index === -1) return data * Math.pow(10, digits);
  const frac = str.slice(index + 1);
  const integer = str.slice(0, index);
  if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
  return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
}
function isMultipleOf(data, min, step) {
  step = Math.abs(step);
  if (!/^\d+\.\d+$/.test(step.toString())) return (data - min) % step === 0;
  const index = step.toString().indexOf(".");
  const digits = step.toString().slice(index + 1).length;
  return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
}
Schema.extend("number", (data, { meta }, options) => {
  if (typeof data !== "number") throw new ValidationError(`expected number but got ${data}`, options);
  checkWithinRange(data, meta, "number", options);
  const { step } = meta;
  if (step && !isMultipleOf(data, meta.min ?? 0, step)) throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
  return [data];
});
Schema.extend("boolean", (data, _, options) => {
  if (typeof data === "boolean") return [data];
  throw new ValidationError(`expected boolean but got ${data}`, options);
});
Schema.extend("bitset", (data, { bits, meta }, options) => {
  let value = 0, keys = [];
  if (typeof data === "number") {
    value = data;
    for (const key in bits) if (data & bits[key]) keys.push(key);
  } else if (Array.isArray(data)) {
    keys = data;
    for (const key of keys) {
      if (typeof key !== "string") throw new ValidationError(`expected string but got ${key}`, options);
      if (key in bits) value |= bits[key];
    }
  } else throw new ValidationError(`expected number or array but got ${data}`, options);
  if (value === meta.default) return [value];
  return [value, keys];
});
Schema.extend("function", (data, _, options) => {
  if (typeof data === "function") return [data];
  throw new ValidationError(`expected function but got ${data}`, options);
});
Schema.extend("is", (data, { constructor }, options) => {
  if (typeof constructor === "function") {
    if (data instanceof constructor) return [data];
    throw new ValidationError(`expected ${constructor.name} but got ${data}`, options);
  } else {
    if (isNullable(data)) throw new ValidationError(`expected ${constructor} but got ${data}`, options);
    let prototype = Object.getPrototypeOf(data);
    while (prototype) {
      if (prototype.constructor?.name === constructor) return [data];
      prototype = Object.getPrototypeOf(prototype);
    }
    throw new ValidationError(`expected ${constructor} but got ${data}`, options);
  }
});
function property(data, key, schema, options) {
  try {
    const [value, adapted] = Schema.resolve(data[key], schema, {
      ...options,
      path: [...options.path || [], key]
    });
    if (adapted !== void 0) data[key] = adapted;
    return value;
  } catch (e) {
    if (!options?.autofix) throw e;
    delete data[key];
    return schema.meta.default;
  }
}
Schema.extend("array", (data, { inner, meta }, options) => {
  if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
  checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
  return [data.map((_, index) => property(data, index, inner, options))];
});
Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
  if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
  const result = {};
  for (const key in data) {
    let rKey;
    try {
      rKey = Schema.resolve(key, sKey, options)[0];
    } catch (error) {
      if (strict) continue;
      throw error;
    }
    result[rKey] = property(data, key, inner, options);
    data[rKey] = data[key];
    if (key !== rKey) delete data[key];
  }
  return [result];
});
Schema.extend("tuple", (data, { list }, options, strict) => {
  if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
  const result = list.map((inner, index) => property(data, index, inner, options));
  if (strict) return [result];
  result.push(...data.slice(list.length));
  return [result];
});
function merge(result, data) {
  for (const key in data) {
    if (key in result) continue;
    result[key] = data[key];
  }
}
Schema.extend("object", (data, { dict }, options, strict) => {
  if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
  const result = {};
  for (const key in dict) {
    const value = property(data, key, dict[key], options);
    if (!isNullable(value) || key in data) result[key] = value;
  }
  if (!strict) merge(result, data);
  return [result];
});
Schema.extend("union", (data, { list, toString: toString2 }, options, strict) => {
  const messages = [];
  for (const inner of list) try {
    return Schema.resolve(data, inner, options, strict);
  } catch (error) {
    messages.push(error);
  }
  throw new ValidationError(`expected ${toString2()} but got ${JSON.stringify(data)}`, options);
});
Schema.extend("intersect", (data, { list, toString: toString2 }, options, strict) => {
  if (!list.length) return [data];
  let result;
  for (const inner of list) {
    const value = Schema.resolve(data, inner, options, true)[0];
    if (isNullable(value)) continue;
    if (isNullable(result)) result = value;
    else if (typeof result !== typeof value) throw new ValidationError(`expected ${toString2()} but got ${JSON.stringify(data)}`, options);
    else if (typeof value === "object") merge(result ??= {}, value);
    else if (result !== value) throw new ValidationError(`expected ${toString2()} but got ${JSON.stringify(data)}`, options);
  }
  if (!strict && isPlainObject(data)) merge(result, data);
  return [result];
});
Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
  const [result, adapted = data] = Schema.resolve(data, inner, options, true);
  if (preserve) return [callback(result)];
  else return [callback(result), callback(adapted)];
});
var formatters = {};
function defineMethod(name2, keys, format) {
  formatters[name2] = format;
  Object.assign(Schema, { [name2](...args) {
    const schema = new Schema({ type: name2 });
    keys.forEach((key, index) => {
      switch (key) {
        case "sKey":
          schema.sKey = args[index] ?? Schema.string();
          break;
        case "inner":
          schema.inner = Schema.from(args[index]);
          break;
        case "list":
          schema.list = args[index].map(Schema.from);
          break;
        case "dict":
          schema.dict = mapValues(args[index], Schema.from);
          break;
        case "bits":
          schema.bits = {};
          for (const key2 in args[index]) {
            if (typeof args[index][key2] !== "number") continue;
            schema.bits[key2] = args[index][key2];
          }
          break;
        case "callback": {
          const callback = schema.callback = args[index];
          callback["toJSON"] ||= () => callback.toString();
          break;
        }
        case "constructor": {
          const constructor = schema.constructor = args[index];
          if (typeof constructor === "function") constructor["toJSON"] ||= () => constructor["name"];
          break;
        }
        default:
          schema[key] = args[index];
      }
    });
    if (name2 === "object" || name2 === "dict") schema.meta.default = {};
    else if (name2 === "array" || name2 === "tuple") schema.meta.default = [];
    else if (name2 === "bitset") schema.meta.default = 0;
    return schema;
  } });
}
defineMethod("is", ["constructor"], ({ constructor }) => {
  if (typeof constructor === "function") return constructor.name;
  else return constructor;
});
defineMethod("any", [], () => "any");
defineMethod("never", [], () => "never");
defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
defineMethod("string", [], () => "string");
defineMethod("number", [], () => "number");
defineMethod("boolean", [], () => "boolean");
defineMethod("bitset", ["bits"], () => "bitset");
defineMethod("function", [], () => "function");
defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
defineMethod("object", ["dict"], ({ dict }) => {
  if (Object.keys(dict).length === 0) return "{}";
  return `{ ${Object.entries(dict).map(([key, inner]) => {
    return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
  }).join(", ")} }`;
});
defineMethod("union", ["list"], ({ list }, inline) => {
  const result = list.map(({ toString: format }) => format()).join(" | ");
  return inline ? `(${result})` : result;
});
defineMethod("intersect", ["list"], ({ list }) => {
  return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
});
defineMethod("transform", [
  "inner",
  "callback",
  "preserve"
], ({ inner }, isInner) => inner.toString(isInner));

// src/tools/excel.ts
import * as XLSX from "xlsx";
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/paths.ts
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve as resolve2 } from "node:path";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
var MAX_OFFICE_FILE_BYTES = 50 * 1024 * 1024;
var MAX_ZIP_ENTRY_BYTES = 256 * 1024 * 1024;
var MAX_ZIP_TOTAL_BYTES = 512 * 1024 * 1024;
var MAX_ZIP_ENTRIES = 1e5;
var MAX_TEXT_CHARS = 2e5;
var MAX_READ_CELLS = 2e5;
var MAX_WRITE_CELLS = 2e5;
function workspaceRootOf(exec) {
  const cwd = exec.agent?.session.header.cwd;
  if (cwd === void 0 || cwd === "") {
    throw new Error("office tools require an active session with a working directory (session.header.cwd is empty)");
  }
  return resolve2(cwd);
}
function displayPathOf(root, absolute) {
  const rel = relative(root, absolute);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolute;
}
function assertLexicallyWithin(root, candidate) {
  const rel = relative(root, candidate);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path "${candidate}" escapes the session workspace "${root}"`);
  }
}
async function assertRealAncestorWithin(root, target) {
  let cursor = target;
  for (; ; ) {
    try {
      await stat(cursor);
      break;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : void 0;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error(`cannot resolve a real parent for "${target}"`);
      cursor = parent;
    }
  }
  const realRoot = resolve2(await realpath(root));
  const realAncestor = resolve2(await realpath(cursor));
  if (realAncestor === realRoot) return;
  assertLexicallyWithin(realRoot, realAncestor);
}
async function resolveOfficePath(exec, rawPath, allowedExts, mustExist) {
  exec.signal.throwIfAborted();
  if (rawPath.trim() === "") throw new Error("path must be a non-empty string");
  const root = workspaceRootOf(exec);
  const candidate = resolve2(isAbsolute(rawPath) ? rawPath : join(root, rawPath));
  assertLexicallyWithin(root, candidate);
  await assertRealAncestorWithin(root, candidate);
  const ext = extname(candidate).toLowerCase();
  if (!allowedExts.includes(ext)) {
    throw new Error(`expected ${allowedExts.join(" or ")} file, got extension "${ext || "(none)"}"`);
  }
  if (mustExist) {
    const info = await stat(candidate);
    if (!info.isFile()) throw new Error(`"${candidate}" is not a regular file`);
  }
  return { input: rawPath, absolute: candidate, display: displayPathOf(root, candidate), ext };
}
async function readOfficeBuffer(path, signal) {
  signal.throwIfAborted();
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`"${path}" is not a regular file`);
  if (info.size > MAX_OFFICE_FILE_BYTES) {
    throw new Error(`"${path}" is ${info.size} bytes; office tools refuse files larger than ${MAX_OFFICE_FILE_BYTES} bytes`);
  }
  const buffer = await readFile(path, { signal });
  signal.throwIfAborted();
  return { buffer, sizeBytes: buffer.byteLength };
}
async function loadZipGuarded(buffer, signal, limits) {
  signal.throwIfAborted();
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`not a readable zip archive (Office files must be valid .docx/.xlsx/.pptx zips): ${reason}`);
  }
  signal.throwIfAborted();
  const maxEntryBytes = limits?.maxEntryBytes ?? MAX_ZIP_ENTRY_BYTES;
  const maxTotalBytes = limits?.maxTotalBytes ?? MAX_ZIP_TOTAL_BYTES;
  const maxEntries = limits?.maxEntries ?? MAX_ZIP_ENTRIES;
  const entries = Object.values(zip.files);
  if (entries.length > maxEntries) {
    throw new Error(`zip archive holds ${entries.length} entries; office tools refuse archives with more than ${maxEntries}`);
  }
  let totalBytes = 0;
  for (const entry of entries) {
    const declared = entry._data?.uncompressedSize;
    if (typeof declared !== "number" || !Number.isFinite(declared)) continue;
    if (declared > maxEntryBytes) {
      throw new Error(`zip entry "${entry.name}" declares ${declared} uncompressed bytes; office tools refuse entries above ${maxEntryBytes} bytes`);
    }
    totalBytes += declared;
    if (totalBytes > maxTotalBytes) {
      throw new Error(`zip archive declares more than ${maxTotalBytes} uncompressed bytes in total (at least ${totalBytes} after "${entry.name}"); refusing to inflate it`);
    }
  }
  return zip;
}
function assertNoXmlDtd(xml, label) {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new Error(`${label} contains a DOCTYPE/ENTITY declaration; office tools refuse such XML parts`);
  }
}
async function readZipXmlPart(zip, name2, signal) {
  signal.throwIfAborted();
  const file = zip.file(name2);
  if (file === null) return null;
  const xml = await file.async("string");
  assertNoXmlDtd(xml, name2);
  return xml;
}
async function atomicWriteFile(path, buffer) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temp = join(directory, `.${randomUUID()}.office-tmp`);
  try {
    await writeFile(temp, buffer, { flag: "wx", mode: 384 });
    await rename(temp, path);
    return buffer.byteLength;
  } catch (error) {
    await rm(temp, { force: true }).catch(() => void 0);
    throw error;
  }
}
async function assertMayCreate(path, overwrite) {
  if (overwrite) return;
  try {
    await stat(path);
    throw new Error(`"${path}" already exists; pass overwrite: true to replace it`);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : void 0;
    if (code === "ENOENT" || code === "ENOTDIR") return;
    if (error instanceof Error && error.message.includes("already exists")) throw error;
    throw error;
  }
}

// src/tools/shared.ts
var CELL_VALUE_SCHEMA = {
  oneOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" }
  ]
};
var ROW_SCHEMA = {
  type: "array",
  items: CELL_VALUE_SCHEMA
};
var FILE_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", required: true },
    sizeBytes: { type: "integer", required: true }
  }
};
function decodeXmlEntities(value) {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (entity, code) => {
    if (code === "amp") return "&";
    if (code === "lt") return "<";
    if (code === "gt") return ">";
    if (code === "quot") return '"';
    if (code === "apos") return "'";
    const number = code.startsWith("#x") ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
    return Number.isFinite(number) ? String.fromCodePoint(number) : entity;
  });
}

// src/tools/excel.ts
var SHEET_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", required: true },
    rowCount: { type: "integer", required: true },
    colCount: { type: "integer", required: true }
  }
};
var EXCEL_CREATE_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...FILE_RESULT_SCHEMA.properties,
    sheets: {
      type: "array",
      required: true,
      items: SHEET_RESULT_SCHEMA
    }
  }
};
var READ_SHEET_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", required: true },
    rows: {
      type: "array",
      required: true,
      items: ROW_SCHEMA
    },
    truncated: { type: "boolean", required: true }
  }
};
var EXCEL_READ_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", required: true },
    sheets: {
      type: "array",
      required: true,
      items: READ_SHEET_RESULT_SCHEMA
    },
    sizeBytes: { type: "integer", required: true }
  }
};
var CELL_UPDATE_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    sheet: { type: "string", required: true },
    cell: { type: "string", required: true }
  }
};
var EXCEL_UPDATE_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...FILE_RESULT_SCHEMA.properties,
    sheetNames: {
      type: "array",
      required: true,
      items: { type: "string" }
    },
    updatedSheets: {
      type: "array",
      required: true,
      items: { type: "string" }
    },
    cellUpdates: {
      type: "array",
      required: true,
      items: CELL_UPDATE_RESULT_SCHEMA
    }
  }
};
function validateSheetSpecs(sheets) {
  if (sheets.length === 0) throw new Error("sheets must contain at least one sheet");
  const seen = /* @__PURE__ */ new Set();
  let totalCells = 0;
  let totalRows = 0;
  for (const sheet of sheets) {
    if (sheet.name.trim() === "") throw new Error("sheet name must be a non-empty string");
    if (seen.has(sheet.name)) throw new Error(`duplicate sheet name "${sheet.name}" in one call`);
    seen.add(sheet.name);
    if (sheet.rows.length > 1e4) throw new Error(`sheet "${sheet.name}" has too many rows (maximum 10000)`);
    totalRows += sheet.rows.length;
    for (const row of sheet.rows) {
      totalCells += row.length;
      if (totalCells > MAX_WRITE_CELLS) throw new Error(`too many worksheet cells (maximum ${MAX_WRITE_CELLS})`);
    }
  }
  if (totalRows === 0) throw new Error("at least one row is required across the sheets");
}
function aoaToSheet(rows) {
  const aoa = rows.map((row) => row.map((cell) => cell === null ? "" : cell));
  const worksheet = XLSX.utils.aoa_to_sheet(aoa);
  materializeFormulas(worksheet);
  return worksheet;
}
function formulaCellOf(cell) {
  const candidate = cell;
  if (candidate.t === "s" && typeof candidate.v === "string" && candidate.v.startsWith("=")) {
    return { t: "e", f: candidate.v.replace(/^=/, "") };
  }
  return void 0;
}
function materializeFormulas(worksheet) {
  for (const [address, cell] of Object.entries(worksheet)) {
    if (address.startsWith("!")) continue;
    const formula = formulaCellOf(cell);
    if (formula !== void 0) worksheet[address] = formula;
  }
}
function writeWorkbookBuffer(workbook) {
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
}
function registerExcelCreate(ctx) {
  return ctx.tools.register(defineTool({
    name: "excel_create",
    description: "Create a new .xlsx Excel workbook in the session workspace from structured sheets. Each sheet has a name and an array of rows; each row is an array of scalar cells (string, number, boolean, or null). Use excel_update to change an existing workbook without recreating it.",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Output path. Relative paths resolve against the session workspace; the extension must be .xlsx."
      },
      sheets: {
        type: "array",
        required: true,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", required: true, description: "Worksheet name (unique within this call)." },
            rows: {
              type: "array",
              required: true,
              items: ROW_SCHEMA,
              description: "Grid rows; the first row is typically a header row. String cells starting with = are written as formulas."
            }
          }
        },
        description: "Sheets to write, in tab order."
      },
      overwrite: {
        type: "boolean",
        description: "Replace the file when it already exists. Defaults to false."
      }
    },
    output: {
      schema: EXCEL_CREATE_OUTPUT,
      render: (_args, value) => [{
        type: "text",
        text: `Created Excel workbook ${value.path} (${value.sizeBytes} bytes; ${value.sheets.length} sheet(s): ${value.sheets.map((sheet) => `${sheet.name} ${sheet.rowCount}x${sheet.colCount}`).join(", ")}).`
      }]
    },
    presentCall: (args) => ({
      card: "generic",
      title: `Create ${args.path}`,
      kind: "edit",
      locations: [{ path: args.path }]
    }),
    async execute(args, exec) {
      const target = await resolveOfficePath(exec, args.path, [".xlsx"], false);
      await assertMayCreate(target.absolute, args.overwrite ?? false);
      validateSheetSpecs(args.sheets);
      exec.signal.throwIfAborted();
      const workbook = XLSX.utils.book_new();
      const summaries = [];
      for (const spec of args.sheets) {
        const worksheet = aoaToSheet(spec.rows);
        XLSX.utils.book_append_sheet(workbook, worksheet, spec.name);
        summaries.push({ name: spec.name, rowCount: spec.rows.length, colCount: spec.rows.length === 0 ? 0 : Math.max(...spec.rows.map((row) => row.length)) });
      }
      const buffer = writeWorkbookBuffer(workbook);
      exec.signal.throwIfAborted();
      const sizeBytes = await atomicWriteFile(target.absolute, buffer);
      return { path: target.display, sizeBytes, sheets: summaries };
    }
  }));
}
function worksheetRows(worksheet) {
  const rangeRef = worksheet["!ref"];
  if (typeof rangeRef !== "string") return [];
  const range = XLSX.utils.decode_range(rangeRef);
  const rows = [];
  for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
    const row = [];
    let hasValue = false;
    for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex += 1) {
      const cell = worksheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
      const value = cellOf(cell);
      if (value !== null) hasValue = true;
      row.push(value);
    }
    if (hasValue) rows.push(row);
  }
  return rows;
}
function cellOf(cell) {
  if (cell === void 0) return null;
  if (cell.t === "e") return typeof cell.f === "string" ? `=${cell.f}` : null;
  if (cell.w !== void 0) return cell.w;
  return cell.v !== void 0 && cell.v !== null ? String(cell.v) : null;
}
function registerExcelRead(ctx) {
  return ctx.tools.register(defineTool({
    name: "excel_read",
    description: 'Read one or all sheets of an existing .xlsx workbook and return each sheet as rows of scalar values (formatted strings). Formula cells return their cached value when one exists; formulas without a cached value return the formula as an "=SUM(\u2026)" string. Rows are capped; the per-sheet `truncated` flag reports when more rows were not returned. Pass `sheet` to read a single named sheet.',
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Path to the .xlsx file, relative to the session workspace or absolute inside it."
      },
      sheet: {
        type: "string",
        description: "Read only this worksheet by exact name. Omit to read every sheet."
      },
      max_rows: {
        type: "integer",
        description: "Maximum rows returned per sheet. Defaults to 5000."
      }
    },
    output: {
      schema: EXCEL_READ_OUTPUT,
      render: (_args, value) => [{
        type: "text",
        text: value.sheets.map(
          (sheet) => `${sheet.name} (${sheet.rows.length} row(s)${sheet.truncated ? ", truncated" : ""}):
` + JSON.stringify(sheet.rows)
        ).join("\n\n")
      }]
    },
    presentCall: (args) => ({
      card: "generic",
      title: `Read ${args.path}`,
      kind: "read",
      locations: [{ path: args.path }]
    }),
    async execute(args, exec) {
      const target = await resolveOfficePath(exec, args.path, [".xlsx"], true);
      const { buffer, sizeBytes } = await readOfficeBuffer(target.absolute, exec.signal);
      await loadZipGuarded(buffer, exec.signal);
      const workbook = XLSX.read(buffer, { type: "buffer", cellFormula: true, cellHTML: false });
      const names = args.sheet === void 0 ? workbook.SheetNames : [args.sheet];
      if (args.sheet !== void 0 && !workbook.SheetNames.includes(args.sheet)) {
        throw new Error(`sheet "${args.sheet}" not found; available sheets: ${workbook.SheetNames.join(", ")}`);
      }
      const maxRows = Math.min(Math.max(args.max_rows ?? 5e3, 1), 1e4);
      const sheets = [];
      let totalCells = 0;
      let budgetExhausted = false;
      for (const name2 of names) {
        const worksheet = workbook.Sheets[name2];
        if (worksheet === void 0) continue;
        const rawRows = worksheetRows(worksheet);
        const rows = [];
        let truncated = false;
        for (const rawRow of rawRows) {
          if (budgetExhausted) break;
          totalCells += rawRow.length;
          if (totalCells > MAX_READ_CELLS) {
            truncated = true;
            budgetExhausted = true;
            break;
          }
          rows.push(rawRow);
          if (rows.length >= maxRows) {
            truncated = rawRows.length > rows.length;
            break;
          }
        }
        if (rawRows.length > rows.length) truncated = true;
        sheets.push({ name: name2, rows, truncated });
      }
      return { path: target.display, sheets, sizeBytes };
    }
  }));
}
function registerExcelUpdate(ctx) {
  return ctx.tools.register(defineTool({
    name: "excel_update",
    description: 'Update an existing .xlsx workbook in place: replace or create whole sheets by name (`sheets`) and/or write individual scalar values into cells (`cell_updates`, e.g. "B2"). The workbook is rewritten by SheetJS, so unsupported features such as charts and macros may be lost; prefer excel_create for new workbooks. Provide at least one sheet or cell update.',
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Path to the existing .xlsx file."
      },
      sheets: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", required: true, description: "Worksheet to replace; created when absent." },
            rows: {
              type: "array",
              required: true,
              items: ROW_SCHEMA,
              description: "Replacement grid rows."
            }
          }
        },
        description: "Whole-sheet replacements (optional)."
      },
      cell_updates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            sheet: { type: "string", required: true, description: "Worksheet name." },
            cell: { type: "string", required: true, description: 'Cell address in A1 notation, e.g. "B2".' },
            value: {
              ...CELL_VALUE_SCHEMA,
              required: true,
              description: "Scalar value to write into the cell. A string starting with = is written as a formula."
            }
          }
        },
        description: "Individual cell writes (optional)."
      }
    },
    output: {
      schema: EXCEL_UPDATE_OUTPUT,
      render: (_args, value) => [{
        type: "text",
        text: `Updated Excel workbook ${value.path} (${value.sizeBytes} bytes). Sheets now: ${value.sheetNames.join(", ")}. Replaced/created sheets: ${value.updatedSheets.length === 0 ? "(none)" : value.updatedSheets.join(", ")}. Cell writes: ${value.cellUpdates.length}.`
      }]
    },
    presentCall: (args) => ({
      card: "generic",
      title: `Update ${args.path}`,
      kind: "edit",
      locations: [{ path: args.path }]
    }),
    async execute(args, exec) {
      const target = await resolveOfficePath(exec, args.path, [".xlsx"], true);
      if ((args.sheets?.length ?? 0) === 0 && (args.cell_updates?.length ?? 0) === 0) {
        throw new Error("excel_update needs at least one entry in sheets or cell_updates");
      }
      const sheetSpecs = args.sheets ?? [];
      if (sheetSpecs.length > 0) validateSheetSpecs(sheetSpecs);
      const { buffer } = await readOfficeBuffer(target.absolute, exec.signal);
      await loadZipGuarded(buffer, exec.signal);
      const workbook = XLSX.read(buffer, { type: "buffer", cellFormula: true, cellHTML: false });
      const updatedSheets = [];
      for (const spec of sheetSpecs) {
        const replacement = aoaToSheet(spec.rows);
        if (workbook.SheetNames.includes(spec.name)) {
          const index = workbook.SheetNames.indexOf(spec.name);
          workbook.Sheets[spec.name] = replacement;
          void index;
        } else {
          XLSX.utils.book_append_sheet(workbook, replacement, spec.name);
        }
        updatedSheets.push(spec.name);
      }
      const cellUpdates = [];
      for (const update of args.cell_updates ?? []) {
        const worksheet = workbook.Sheets[update.sheet];
        if (worksheet === void 0) throw new Error(`sheet "${update.sheet}" not found for cell update; available sheets: ${workbook.SheetNames.join(", ")}`);
        try {
          XLSX.utils.decode_cell(update.cell);
        } catch {
          throw new Error(`invalid cell address "${update.cell}"; use A1 notation such as "B2"`);
        }
        XLSX.utils.sheet_add_aoa(worksheet, [[update.value === null ? "" : update.value]], { origin: update.cell });
        const formula = formulaCellOf(worksheet[update.cell]);
        if (formula !== void 0) worksheet[update.cell] = formula;
        cellUpdates.push({ sheet: update.sheet, cell: update.cell });
      }
      exec.signal.throwIfAborted();
      const sizeBytes = await atomicWriteFile(target.absolute, writeWorkbookBuffer(workbook));
      return {
        path: target.display,
        sizeBytes,
        sheetNames: workbook.SheetNames,
        updatedSheets,
        cellUpdates
      };
    }
  }));
}
function registerExcelTools(ctx) {
  const disposers = [registerExcelCreate(ctx), registerExcelRead(ctx), registerExcelUpdate(ctx)];
  return () => disposers.forEach((dispose) => dispose());
}

// src/tools/ppt.ts
import { stat as stat2 } from "node:fs/promises";
import pptxgen from "pptxgenjs";
import { defineTool as defineTool2 } from "@deepseek-ai/dsh-tools";
var IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif"];
var MAX_IMAGE_BYTES = 20 * 1024 * 1024;
var MAX_IMAGES_PER_SLIDE = 20;
var SLIDE_SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    index: { type: "integer", required: true },
    title: { type: "string" },
    paragraphs: {
      type: "array",
      required: true,
      items: { type: "string" }
    },
    notes: {
      type: "array",
      items: { type: "string" }
    },
    tables: {
      type: "array",
      items: { type: "array", items: { type: "array", items: { type: "string" } } },
      description: "Tables as rows of cell texts (paragraphs joined with spaces); present only when the slide has tables."
    },
    imageAlts: {
      type: "array",
      items: { type: "string" },
      description: "Alt text (descr) of the slide's pictures in order; present only when at least one is non-empty."
    },
    imageCount: { type: "integer", required: true }
  }
};
var PPT_CREATE_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...FILE_RESULT_SCHEMA.properties,
    title: { type: "string" },
    slideCount: { type: "integer", required: true },
    imageCount: { type: "integer", required: true }
  }
};
var PPT_READ_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", required: true },
    slideCount: { type: "integer", required: true },
    slides: {
      type: "array",
      required: true,
      items: SLIDE_SUMMARY_SCHEMA
    },
    truncated: { type: "boolean", required: true },
    sizeBytes: { type: "integer", required: true }
  }
};
function assertPositiveCoordinate(value, label, slideIndex2, imageIndex) {
  if (value === void 0) return;
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    throw new Error(`slide ${slideIndex2} image ${imageIndex + 1} ${label} must be a positive number of inches (0-100)`);
  }
}
function validateSlideSpecs(slides) {
  if (slides.length === 0) throw new Error("slides must contain at least one slide");
  if (slides.length > 200) throw new Error("too many slides (maximum 200)");
  for (const [slideIndex2, slide] of slides.entries()) {
    const hasContent = (slide.title?.trim().length ?? 0) > 0 || (slide.paragraphs?.length ?? 0) > 0 || (slide.bullets?.length ?? 0) > 0 || (slide.images?.length ?? 0) > 0;
    if (!hasContent) throw new Error(`slide ${slideIndex2 + 1} is empty; give it a title, paragraphs, bullets, or images`);
    if ((slide.paragraphs?.length ?? 0) + (slide.bullets?.length ?? 0) > 500) {
      throw new Error(`slide ${slideIndex2 + 1} has too many text blocks (maximum 500)`);
    }
    const images = slide.images ?? [];
    if (images.length > MAX_IMAGES_PER_SLIDE) {
      throw new Error(`slide ${slideIndex2 + 1} has too many images (maximum ${MAX_IMAGES_PER_SLIDE})`);
    }
    for (const [imageIndex, image] of images.entries()) {
      assertPositiveCoordinate(image.x, "x", slideIndex2 + 1, imageIndex);
      assertPositiveCoordinate(image.y, "y", slideIndex2 + 1, imageIndex);
      assertPositiveCoordinate(image.w, "w", slideIndex2 + 1, imageIndex);
      assertPositiveCoordinate(image.h, "h", slideIndex2 + 1, imageIndex);
      if (image.sizing !== void 0 && (image.w === void 0 || image.h === void 0)) {
        throw new Error(`slide ${slideIndex2 + 1} image ${imageIndex + 1} uses sizing; provide both w and h`);
      }
    }
  }
}
async function resolveSlideImages(exec, slides) {
  return Promise.all(slides.map(async (slide, slideIndex2) => {
    const images = slide.images ?? [];
    return Promise.all(images.map(async (image, imageIndex) => {
      const resolved = await resolveOfficePath(exec, image.path, IMAGE_EXTENSIONS, true);
      const info = await stat2(resolved.absolute);
      if (info.size > MAX_IMAGE_BYTES) {
        throw new Error(`slide ${slideIndex2 + 1} image ${imageIndex + 1} "${image.path}" is ${info.size} bytes; maximum embedded image size is ${MAX_IMAGE_BYTES} bytes`);
      }
      return { ...image, absolute: resolved.absolute };
    }));
  }));
}
function addSlideContent(pptx, spec, first, images) {
  const slide = pptx.addSlide();
  const hasTitle = spec.title !== void 0 && spec.title.trim() !== "";
  if (first && hasTitle) {
    slide.addText(spec.title, {
      x: 0.8,
      y: 1.2,
      w: 8.4,
      h: 1.2,
      fontSize: 32,
      bold: true,
      align: "center",
      color: "1F3864"
    });
  } else if (hasTitle) {
    slide.addText(spec.title, {
      x: 0.8,
      y: 0.35,
      w: 8.4,
      h: 0.9,
      fontSize: 26,
      bold: true,
      color: "1F3864"
    });
  }
  const top = first && hasTitle ? 2.7 : hasTitle ? 1.5 : 0.8;
  let y = top;
  if ((spec.paragraphs?.length ?? 0) > 0) {
    for (const paragraph of spec.paragraphs) {
      if (y > 6.4) break;
      slide.addText(paragraph, { x: 0.8, y, w: 8.4, h: 0.7, fontSize: 18, valign: "top" });
      y += 0.8;
    }
    y += 0.2;
  }
  if ((spec.bullets?.length ?? 0) > 0) {
    slide.addText(spec.bullets.map((item) => ({ text: item, options: { bullet: true } })), {
      x: 0.8,
      y,
      w: 8.4,
      h: Math.min(4.5, Math.max(1, spec.bullets.length * 0.6)),
      fontSize: 18,
      valign: "top",
      lineSpacingMultiple: 1.2
    });
  }
  if (images.length > 0) {
    const automatic = images.filter((image) => image.x === void 0 && image.y === void 0 && image.w === void 0 && image.h === void 0);
    const automaticHeight = Math.max(0.6, Math.min(3.2, (6.6 - Math.min(y, 6.4)) / Math.max(1, automatic.length)));
    let imageY = Math.min(y + 0.25, 6.5);
    for (const image of images) {
      const options = { path: image.absolute };
      if (image.x !== void 0) options.x = image.x;
      if (image.y !== void 0) options.y = image.y;
      if (image.w !== void 0) options.w = image.w;
      if (image.h !== void 0) options.h = image.h;
      if (image.sizing !== void 0) {
        options.sizing = { type: image.sizing, w: image.w, h: image.h };
      }
      if (automatic.includes(image)) {
        options.x = 0.8;
        options.y = imageY;
        options.w = 8.4;
        options.h = automaticHeight;
        options.sizing = { type: image.sizing ?? "contain", w: 8.4, h: automaticHeight };
        imageY += automaticHeight + 0.15;
      }
      slide.addImage(options);
    }
  }
  if (spec.notes !== void 0 && spec.notes.trim() !== "") {
    slide.addNotes(spec.notes);
  }
}
async function buildPptx(args, imagesBySlide) {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "DeepSeek Harness";
  pptx.company = "DSH";
  pptx.subject = args.title ?? "Presentation";
  pptx.title = args.title ?? "Presentation";
  let first = true;
  if (args.title !== void 0 && args.title.trim() !== "") {
    addSlideContent(pptx, { title: args.title }, true, []);
    first = false;
  }
  const slides = args.slides ?? [];
  for (let index = 0; index < slides.length; index += 1) {
    addSlideContent(pptx, slides[index], first, imagesBySlide[index] ?? []);
    first = false;
  }
  const output = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.isBuffer(output) ? output : Buffer.from(output);
}
function paragraphText(paragraphXml) {
  const runs = [];
  const runPattern = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
  for (const match of paragraphXml.matchAll(runPattern)) runs.push(match[1] ?? "");
  const text = decodeXmlEntities(runs.join("").replace(/<a:br\b[^>]*\/>/g, "\n"));
  return text;
}
function extractParagraphs(xml, skipFields) {
  const paragraphs = [];
  const pattern2 = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
  for (const match of xml.matchAll(pattern2)) {
    const paragraph = match[1] ?? "";
    if (skipFields && /<a:fld\b/.test(paragraph)) continue;
    const text = paragraphText(paragraph);
    if (text.trim() !== "") paragraphs.push(text);
  }
  return paragraphs;
}
var A_TABLE = /<a:tbl\b[\s\S]*?<\/a:tbl>/g;
var A_TABLE_ROW = /<a:tr\b[\s\S]*?<\/a:tr>/g;
var A_TABLE_CELL = /<a:tc\b[\s\S]*?<\/a:tc>/g;
var PICTURE = /<p:pic\b[\s\S]*?<\/p:pic>/g;
var PICTURE_DESCR = /<p:cNvPr\b[^>]*\bdescr="([^"]*)"/;
function extractTables(slideXml) {
  const tables = [];
  for (const tableMatch of slideXml.matchAll(A_TABLE)) {
    const rows = [...(tableMatch[0] ?? "").matchAll(A_TABLE_ROW)].map((rowMatch) => [...(rowMatch[0] ?? "").matchAll(A_TABLE_CELL)].map((cellMatch) => extractParagraphs(cellMatch[0] ?? "", false).join(" ")));
    if (rows.length > 0) tables.push(rows);
  }
  return tables;
}
function stripTables(slideXml) {
  return slideXml.replace(A_TABLE, "");
}
function extractImageAlts(slideXml) {
  const alts = [];
  for (const pictureMatch of slideXml.matchAll(PICTURE)) {
    const descrMatch = PICTURE_DESCR.exec(pictureMatch[0] ?? "");
    const descr = descrMatch === null ? void 0 : descrMatch[1];
    if (descr !== void 0 && descr.trim() !== "") alts.push(decodeXmlEntities(descr));
  }
  return alts;
}
function decodeRelationshipTarget(xml) {
  const match = /Target="([^"]*notesSlides\/notesSlide(\d+)\.xml)"/.exec(xml);
  if (match === null) return void 0;
  return `ppt/notesSlides/notesSlide${match[2]}.xml`;
}
function slideIndex(name2) {
  const match = /slide(\d+)\.xml$/.exec(name2);
  return match === null ? Number.MAX_SAFE_INTEGER : Number.parseInt(match[1], 10);
}
async function countSlideImages(zip, slideNumber) {
  const relationship = zip.file(`ppt/slides/_rels/slide${slideNumber}.xml.rels`);
  if (relationship === null) return 0;
  const xml = await readXmlEntry(relationship);
  return [...xml.matchAll(/Type="[^"]*\/image"/g)].length;
}
async function readXmlEntry(file) {
  const xml = await file.async("string");
  assertNoXmlDtd(xml, file.name);
  return xml;
}
async function readSlideXml(zip) {
  const slideFiles = zip.file(/ppt\/slides\/slide[0-9]+\.xml$/);
  slideFiles.sort((a, b) => slideIndex(a.name) - slideIndex(b.name));
  const xmls = await Promise.all(slideFiles.map(readXmlEntry));
  const notes = await Promise.all(Array.from({ length: xmls.length }, async (_, index) => {
    const slideNumber = index + 1;
    const relationship = zip.file(`ppt/slides/_rels/slide${slideNumber}.xml.rels`);
    let notesName = `ppt/notesSlides/notesSlide${slideNumber}.xml`;
    if (relationship !== null) {
      const target = decodeRelationshipTarget(await readXmlEntry(relationship));
      if (target !== void 0) notesName = target;
    }
    const noteFile = zip.file(notesName);
    if (noteFile === null) return void 0;
    const paragraphs = extractParagraphs(await readXmlEntry(noteFile), true);
    return paragraphs.length === 0 ? void 0 : paragraphs.join("\n");
  }));
  const imageCounts = await Promise.all(Array.from({ length: xmls.length }, (_, index) => countSlideImages(zip, index + 1)));
  return { xmls, notes, imageCounts };
}
function registerPptCreate(ctx) {
  return ctx.tools.register(defineTool2({
    name: "ppt_create",
    description: "Create a PowerPoint .pptx presentation in the session workspace. Optionally start with a title slide, then add slides with a title, body paragraphs, bullet points, speaker notes, and PNG/JPG/GIF images. Image paths are workspace files; give x/y/w/h in inches to position them explicitly, or omit them for automatic centered placement below the text. The deck uses the 16:9 widescreen layout.",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Output path. Relative paths resolve against the session workspace; the extension must be .pptx."
      },
      title: {
        type: "string",
        description: "Deck title. When provided, a title slide is inserted before the explicit slides."
      },
      slides: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string", description: "Slide title." },
            paragraphs: {
              type: "array",
              items: { type: "string" },
              description: "Body paragraphs rendered as plain text boxes."
            },
            bullets: {
              type: "array",
              items: { type: "string" },
              description: "Bullet list items rendered after the paragraphs."
            },
            notes: { type: "string", description: "Speaker notes for this slide." },
            images: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  path: {
                    type: "string",
                    required: true,
                    description: "Image file inside the session workspace: .png, .jpg, .jpeg, or .gif (absolute paths must stay inside the workspace)."
                  },
                  x: { type: "number", description: "Left position in inches on the 13.33x7.5 slide. Omit for automatic placement." },
                  y: { type: "number", description: "Top position in inches. Omit for automatic placement." },
                  w: { type: "number", description: "Display width in inches. Omit to use the native image size." },
                  h: { type: "number", description: "Display height in inches. Omit to use the native image size." },
                  sizing: {
                    type: "string",
                    enum: ["contain", "cover"],
                    description: "Fit mode inside the w x h box. Requires w and h; defaults to contain for automatic placement."
                  }
                }
              },
              description: "Images to embed on this slide, drawn after the text content."
            }
          }
        },
        description: "Slides in presentation order. Optional when a title is provided."
      },
      overwrite: {
        type: "boolean",
        description: "Replace the file when it already exists. Defaults to false."
      }
    },
    output: {
      schema: PPT_CREATE_OUTPUT,
      render: (_args, value) => [{
        type: "text",
        text: `Created PowerPoint ${value.path} (${value.sizeBytes} bytes; ${value.slideCount} slide(s), ${value.imageCount} image(s)).`
      }]
    },
    presentCall: (args) => ({
      card: "generic",
      title: `Create ${args.path}`,
      kind: "edit",
      locations: [{ path: args.path }]
    }),
    async execute(args, exec) {
      const target = await resolveOfficePath(exec, args.path, [".pptx"], false);
      await assertMayCreate(target.absolute, args.overwrite ?? false);
      if ((args.slides?.length ?? 0) > 0) validateSlideSpecs(args.slides);
      if (args.title === void 0 && (args.slides?.length ?? 0) === 0) {
        throw new Error("ppt_create needs a title or at least one slide");
      }
      exec.signal.throwIfAborted();
      const slides = args.slides ?? [];
      const imagesBySlide = await resolveSlideImages(exec, slides);
      const imageCount = imagesBySlide.reduce((sum, images) => sum + images.length, 0);
      const buffer = await buildPptx(args, imagesBySlide);
      exec.signal.throwIfAborted();
      const sizeBytes = await atomicWriteFile(target.absolute, buffer);
      const result = {
        path: target.display,
        sizeBytes,
        slideCount: (args.title !== void 0 && args.title.trim() !== "" ? 1 : 0) + slides.length,
        imageCount
      };
      if (args.title !== void 0 && args.title.trim() !== "") result.title = args.title;
      return result;
    }
  }));
}
function registerPptRead(ctx) {
  return ctx.tools.register(defineTool2({
    name: "ppt_read",
    description: "Extract text from an existing .pptx presentation: every slide's paragraphs, tables (rows of cell texts), speaker notes, embedded image count, and image alt texts, in slide order. Table cell text is reported under `tables`, not duplicated into `paragraphs`. Use it to understand or summarize a deck before editing it.",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Path to the .pptx file, relative to the session workspace or absolute inside it."
      },
      max_chars: {
        type: "integer",
        description: `Maximum characters returned across the deck. Defaults to ${MAX_TEXT_CHARS}.`
      }
    },
    output: {
      schema: PPT_READ_OUTPUT,
      render: (_args, value) => [{
        type: "text",
        text: value.slides.map(
          (slide) => `Slide ${slide.index}${slide.title !== void 0 ? ` \u2014 ${slide.title}` : ""} (images: ${slide.imageCount}${slide.imageAlts !== void 0 ? `; alts: ${slide.imageAlts.join(" | ")}` : ""}):
` + slide.paragraphs.map((paragraph) => `- ${paragraph}`).join("\n") + (slide.tables !== void 0 ? `
Tables:
${slide.tables.map((table) => table.map((row) => row.join(" | ")).join("\n")).join("\n\n")}` : "") + (slide.notes !== void 0 ? `
Notes: ${slide.notes.join(" | ")}` : "")
        ).join("\n\n") + (value.truncated ? "\n[text truncated]" : "")
      }]
    },
    presentCall: (args) => ({
      card: "generic",
      title: `Read ${args.path}`,
      kind: "read",
      locations: [{ path: args.path }]
    }),
    async execute(args, exec) {
      const target = await resolveOfficePath(exec, args.path, [".pptx"], true);
      const { buffer, sizeBytes } = await readOfficeBuffer(target.absolute, exec.signal);
      const zip = await loadZipGuarded(buffer, exec.signal);
      const { xmls, notes, imageCounts } = await readSlideXml(zip);
      if (xmls.length === 0) throw new Error("the .pptx contains no slides");
      const maxChars = Math.min(Math.max(args.max_chars ?? MAX_TEXT_CHARS, 1), MAX_TEXT_CHARS);
      const slides = [];
      let totalChars = 0;
      let truncated = false;
      for (let index = 0; index < xmls.length; index += 1) {
        const slideXml = xmls[index];
        const paragraphs = extractParagraphs(stripTables(slideXml), false);
        const tables = extractTables(slideXml);
        const imageAlts = extractImageAlts(slideXml);
        const noteText = notes[index];
        const noteParagraphs = noteText === void 0 || noteText.trim() === "" ? void 0 : [noteText];
        const body = paragraphs;
        const remainingChars = Math.max(0, maxChars - totalChars);
        let slideChars = 0;
        const bounded = body.map((paragraph) => {
          if (slideChars >= remainingChars) return "";
          const retained = paragraph.slice(0, remainingChars - slideChars);
          slideChars += retained.length;
          return retained;
        });
        const noteBounded = noteParagraphs === void 0 ? void 0 : [noteParagraphs[0].slice(0, Math.max(0, remainingChars - slideChars))];
        const bodyChars = body.reduce((sum, paragraph) => sum + paragraph.length, 0);
        const noteChars = noteParagraphs?.[0]?.length ?? 0;
        totalChars += slideChars + (noteBounded?.[0]?.length ?? 0);
        if (bodyChars + noteChars > slideChars + (noteBounded?.[0]?.length ?? 0)) truncated = true;
        const tablesChars = tables.reduce((sum, table) => sum + table.reduce((rowSum, row) => rowSum + row.join("").length, 0), 0);
        const tablesFit = totalChars + tablesChars <= maxChars;
        if (!tablesFit && tables.length > 0) truncated = true;
        const slide = {
          index: index + 1,
          paragraphs: bounded.filter((paragraph) => paragraph !== ""),
          imageCount: imageCounts[index] ?? 0
        };
        if (noteBounded !== void 0) slide.notes = noteBounded;
        if (tablesFit && tables.length > 0) {
          slide.tables = tables;
          totalChars += tablesChars;
        }
        if (imageAlts.length > 0) slide.imageAlts = imageAlts;
        slides.push(slide);
      }
      return { path: target.display, slideCount: slides.length, slides, truncated, sizeBytes };
    }
  }));
}
function registerPptTools(ctx) {
  const disposers = [registerPptCreate(ctx), registerPptRead(ctx)];
  return () => disposers.forEach((dispose) => dispose());
}

// src/tools/word.ts
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import { defineTool as defineTool4 } from "@deepseek-ai/dsh-tools";

// src/tools/word-update.ts
import { defineTool as defineTool3 } from "@deepseek-ai/dsh-tools";
var WORD_UPDATE_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...FILE_RESULT_SCHEMA.properties,
    appendedParagraphs: { type: "integer", required: true },
    appendedBullets: { type: "integer", required: true },
    appendedTableRows: { type: "integer", required: true }
  }
};
function registerWordUpdate(ctx) {
  return ctx.tools.register(defineTool3({
    name: "word_update",
    description: "Append content to an existing .docx Word document in the session workspace: paragraphs, bullet points, and/or one table are added at the end of the body (in that order), leaving everything already in the file untouched. Bullets reuse the list numbering the document already defines, so they render as bullets in files that have them (files created by word_create always do); documents without list numbering show appended bullets as plain paragraphs. The file is rewritten atomically. Use word_read afterwards to verify.",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Path to the existing .docx file, relative to the session workspace or absolute inside it."
      },
      paragraphs: {
        type: "array",
        items: { type: "string" },
        description: "Paragraphs to append in document order. Optional."
      },
      bullets: {
        type: "array",
        items: { type: "string" },
        description: "Bullet list items appended after the paragraphs. Optional."
      },
      table: {
        type: "object",
        additionalProperties: false,
        properties: {
          headers: {
            type: "array",
            items: { type: "string" },
            required: true,
            description: "Table column headers (bold)."
          },
          rows: {
            type: "array",
            items: { type: "array", items: { type: "string" } },
            required: true,
            description: "Table body rows; each row should match the header column count."
          }
        },
        description: "One optional table appended after the text content."
      }
    },
    output: {
      schema: WORD_UPDATE_OUTPUT,
      render: (_args, value) => [{
        type: "text",
        text: `Appended to Word document ${value.path} (${value.sizeBytes} bytes; ${value.appendedParagraphs} paragraph(s), ${value.appendedBullets} bullet(s), ${value.appendedTableRows} table body row(s) appended).`
      }]
    },
    presentCall: (args) => ({
      card: "generic",
      title: `Update ${args.path}`,
      kind: "edit",
      locations: [{ path: args.path }]
    }),
    async execute(args, exec) {
      const target = await resolveOfficePath(exec, args.path, [".docx"], true);
      const { paragraphs: paragraphCount, cells } = wordCreateCounts(args);
      if ((args.paragraphs?.length ?? 0) === 0 && (args.bullets?.length ?? 0) === 0 && args.table === void 0) {
        throw new Error("word_update needs at least one of paragraphs, bullets, or table");
      }
      if (paragraphCount > 1e4) throw new Error("too many paragraphs/bullets/table rows (maximum 10000)");
      if (cells > 2e5) throw new Error("too many table cells (maximum 200000)");
      exec.signal.throwIfAborted();
      const { buffer } = await readOfficeBuffer(target.absolute, exec.signal);
      const zip = await loadZipGuarded(buffer, exec.signal);
      const documentXml = await readZipXmlPart(zip, "word/document.xml", exec.signal);
      if (documentXml === null) {
        throw new Error("the .docx has no word/document.xml part; is this a valid Word file?");
      }
      const fragment = await buildAppendFragment(args, exec.signal);
      const updated = appendBeforeSectPr(documentXml, fragment);
      zip.file("word/document.xml", updated);
      const output = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
      exec.signal.throwIfAborted();
      const sizeBytes = await atomicWriteFile(target.absolute, output);
      return {
        path: target.display,
        sizeBytes,
        appendedParagraphs: args.paragraphs?.length ?? 0,
        appendedBullets: args.bullets?.length ?? 0,
        appendedTableRows: args.table?.rows.length ?? 0
      };
    }
  }));
}

// src/tools/word.ts
var WORD_CREATE_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...FILE_RESULT_SCHEMA.properties,
    title: { type: "string" },
    paragraphCount: { type: "integer", required: true },
    bulletCount: { type: "integer", required: true },
    tableRows: { type: "integer", required: true }
  }
};
var WORD_READ_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", required: true },
    text: { type: "string", required: true },
    totalChars: { type: "integer", required: true },
    truncated: { type: "boolean", required: true },
    sizeBytes: { type: "integer", required: true }
  }
};
function wordCreateCounts(args) {
  const tableCells = args.table === void 0 ? 0 : (args.table.headers.length + args.table.rows.length) * Math.max(1, args.table.headers.length);
  return {
    paragraphs: (args.title === void 0 ? 0 : 1) + (args.paragraphs?.length ?? 0) + (args.bullets?.length ?? 0) + (args.table === void 0 ? 0 : 1 + args.table.rows.length),
    cells: tableCells
  };
}
async function buildDocx(args) {
  const children = [];
  if (args.title !== void 0 && args.title.trim() !== "") {
    children.push(new Paragraph({ text: args.title, heading: HeadingLevel.TITLE }));
  }
  for (const text of args.paragraphs ?? []) {
    children.push(new Paragraph(text === "" ? { text: "" } : { children: [new TextRun(text)] }));
  }
  for (const item of args.bullets ?? []) {
    children.push(new Paragraph({ text: item, bullet: { level: 0 } }));
  }
  if (args.table !== void 0) {
    const widths = args.table.headers.length;
    const cellWidth = widths > 0 ? Math.max(1, Math.floor(100 / widths)) : 100;
    const rows = [
      new TableRow({
        children: args.table.headers.map((header) => new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: header, bold: true })] })],
          width: { size: cellWidth, type: WidthType.PERCENTAGE }
        }))
      }),
      ...args.table.rows.map((row) => new TableRow({
        children: row.map((cell) => new TableCell({
          children: [new Paragraph({ text: cell })],
          width: { size: cellWidth, type: WidthType.PERCENTAGE }
        }))
      }))
    ];
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows
    }));
  }
  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}
var W_RUN_PART = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:t\b[^>]*\/>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>|<w:cr\b[^>]*\/?>|<w:noBreakHyphen\b[^>]*\/?>|<w:softHyphen\b[^>]*\/?>/g;
var W_PARAGRAPH = /<w:p\b[^>]*\/>|<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
function paragraphBodyText(bodyXml) {
  const parts = [];
  for (const match of bodyXml.matchAll(W_RUN_PART)) {
    if (match[1] !== void 0) {
      parts.push(decodeXmlEntities(match[1]));
    } else if (match[0].startsWith("<w:tab")) {
      parts.push("	");
    } else if (match[0].startsWith("<w:noBreakHyphen")) {
      parts.push("\u2011");
    } else if (match[0].startsWith("<w:softHyphen")) {
      parts.push("\xAD");
    }
  }
  return parts.join("");
}
function extractDocxText(documentXml) {
  return [...documentXml.matchAll(W_PARAGRAPH)].map((match) => (match[1] === void 0 ? "" : paragraphBodyText(match[1])) + "\n\n").join("");
}
var W_BLOCK = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
var W_HEADING_LEVELS = {
  Title: 1,
  Heading1: 1,
  Heading2: 2,
  Heading3: 3,
  Heading4: 4,
  Heading5: 5,
  Heading6: 6
};
var W_P_STYLE = /<w:pStyle w:val="([^"]*)"/;
var W_NUM_PR = /<w:numPr>/;
var W_ILVL = /<w:ilvl w:val="(\d+)"/;
var W_TABLE_ROW = /<w:tr\b[\s\S]*?<\/w:tr>/g;
var W_TABLE_CELL = /<w:tc\b[\s\S]*?<\/w:tc>/g;
function markdownParagraph(paragraphXml) {
  const styleMatch = W_P_STYLE.exec(paragraphXml);
  const styleId = styleMatch === null ? void 0 : styleMatch[1];
  const body = paragraphBodyText(paragraphXml);
  if (styleId !== void 0 && W_HEADING_LEVELS[styleId] !== void 0) {
    return `${"#".repeat(W_HEADING_LEVELS[styleId])} ${body}`;
  }
  if (W_NUM_PR.test(paragraphXml)) {
    const levelMatch = W_ILVL.exec(paragraphXml);
    const level = levelMatch === null ? 0 : Number.parseInt(levelMatch[1], 10);
    return `${"  ".repeat(Math.min(level, 8))}- ${body}`;
  }
  return body;
}
function markdownCellText(cellXml) {
  return [...cellXml.matchAll(W_PARAGRAPH)].map((match) => paragraphBodyText(match[1] ?? "").trim()).filter((text) => text !== "").join(" ");
}
function markdownTable(tableXml) {
  const rows = [...tableXml.matchAll(W_TABLE_ROW)].map((rowMatch) => [...(rowMatch[0] ?? "").matchAll(W_TABLE_CELL)].map((cellMatch) => markdownCellText(cellMatch[0] ?? "").replace(/\|/g, "\\|")));
  const columns = rows.reduce((width, row) => Math.max(width, row.length), 0);
  if (columns === 0) return "";
  const line = (cells) => `| ${[...cells, ...Array.from({ length: columns - cells.length }, () => "")].join(" | ")} |`;
  return [line(rows[0] ?? []), `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}
function extractDocxMarkdown(documentXml) {
  const blocks = [];
  for (const match of documentXml.matchAll(W_BLOCK)) {
    const block = match[0] ?? "";
    if (block.startsWith("<w:tbl")) {
      blocks.push(markdownTable(block));
    } else {
      blocks.push(markdownParagraph(match[1] ?? ""));
    }
  }
  return blocks.join("\n\n");
}
var DOCUMENT_BODY = /<w:body>([\s\S]*)<\/w:body>/g;
var TRAILING_SECT_PR = /<w:sectPr[\s\S]*<\/w:sectPr>\s*$/;
async function buildAppendFragment(args, signal) {
  const buffer = await buildDocx({ path: args.path, paragraphs: args.paragraphs, bullets: args.bullets, table: args.table });
  const zip = await loadZipGuarded(buffer, signal);
  const documentXml = await readZipXmlPart(zip, "word/document.xml", signal);
  if (documentXml === null) throw new Error("internal error: the append document has no word/document.xml part");
  const body = [...documentXml.matchAll(DOCUMENT_BODY)][0]?.[1];
  if (body === void 0) throw new Error("internal error: the append document has no body");
  return body.replace(TRAILING_SECT_PR, "");
}
function appendBeforeSectPr(documentXml, addition) {
  const sectStart = documentXml.lastIndexOf("<w:sectPr");
  const closeStart = sectStart !== -1 ? -1 : documentXml.lastIndexOf("</w:body>");
  const splitAt = sectStart !== -1 ? sectStart : closeStart;
  if (splitAt === -1) throw new Error("word/document.xml has no </w:body>; refusing to modify it");
  const pieces = [documentXml.slice(0, splitAt), addition, documentXml.slice(splitAt)];
  return pieces.join("");
}
function registerWordCreate(ctx) {
  return ctx.tools.register(defineTool4({
    name: "word_create",
    description: "Create a Microsoft Word .docx document inside the session workspace from structured content. Supply paragraphs as plain text, optional bullet points, and one optional table (headers + string rows). The file is written atomically; pass overwrite: true to replace an existing file. Use word_read afterwards to verify the extracted text.",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Output path. Relative paths resolve against the session workspace; the extension must be .docx."
      },
      title: {
        type: "string",
        description: "Document title rendered as the title heading. Optional."
      },
      paragraphs: {
        type: "array",
        items: { type: "string" },
        description: "Body paragraphs in document order. Empty strings create blank paragraphs. Optional."
      },
      bullets: {
        type: "array",
        items: { type: "string" },
        description: "Bullet list items rendered after the paragraphs. Optional."
      },
      table: {
        type: "object",
        additionalProperties: false,
        properties: {
          headers: {
            type: "array",
            items: { type: "string" },
            required: true,
            description: "Table column headers (bold)."
          },
          rows: {
            type: "array",
            items: { type: "array", items: { type: "string" } },
            required: true,
            description: "Table body rows; each row should match the header column count."
          }
        },
        description: "One optional table appended after the text content."
      },
      overwrite: {
        type: "boolean",
        description: "Replace the file when it already exists. Defaults to false (existing files are refused)."
      }
    },
    output: {
      schema: WORD_CREATE_OUTPUT,
      render: (_args, value) => [{
        type: "text",
        text: `Created Word document ${value.path} (${value.sizeBytes} bytes; ${value.paragraphCount} paragraphs, ${value.bulletCount} bullets, ${value.tableRows} table body rows).`
      }]
    },
    presentCall: (args) => ({
      card: "generic",
      title: `Create ${args.path}`,
      kind: "edit",
      locations: [{ path: args.path }]
    }),
    async execute(args, exec) {
      const target = await resolveOfficePath(exec, args.path, [".docx"], false);
      await assertMayCreate(target.absolute, args.overwrite ?? false);
      exec.signal.throwIfAborted();
      const { paragraphs: paragraphCount, cells } = wordCreateCounts(args);
      if (paragraphCount > 1e4) throw new Error("too many paragraphs/bullets/table rows (maximum 10000)");
      if (cells > 2e5) throw new Error("too many table cells (maximum 200000)");
      if (args.title === void 0 && (args.paragraphs?.length ?? 0) === 0 && (args.bullets?.length ?? 0) === 0 && args.table === void 0) {
        throw new Error("word_create needs at least one of title, paragraphs, bullets, or table");
      }
      const buffer = await buildDocx(args);
      exec.signal.throwIfAborted();
      const sizeBytes = await atomicWriteFile(target.absolute, buffer);
      const result = {
        path: target.display,
        sizeBytes,
        paragraphCount: (args.title === void 0 || args.title.trim() === "" ? 0 : 1) + (args.paragraphs?.length ?? 0),
        bulletCount: args.bullets?.length ?? 0,
        tableRows: args.table?.rows.length ?? 0
      };
      if (args.title !== void 0 && args.title.trim() !== "") result.title = args.title;
      return result;
    }
  }));
}
function registerWordRead(ctx) {
  return ctx.tools.register(defineTool4({
    name: "word_read",
    description: 'Extract text from an existing .docx Word document in the session workspace. Default plain-text mode returns the document text up to the character limit with a truncated flag. Pass format: "markdown" for structured markdown instead: Title/Heading1-6 become # .. ###### headings, bullet/numbered paragraphs become "- " items (indented by level), and tables become markdown tables.',
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Path to the .docx file, relative to the session workspace or absolute inside it."
      },
      max_chars: {
        type: "integer",
        description: `Maximum characters to return. Defaults to ${MAX_TEXT_CHARS}.`
      },
      format: {
        type: "string",
        enum: ["text", "markdown"],
        description: "Output mode: plain text (default) or structured markdown."
      }
    },
    output: {
      schema: WORD_READ_OUTPUT,
      render: (_args, value) => [{
        type: "text",
        text: value.text + (value.truncated ? `
[text truncated; total ${value.totalChars} characters]` : "")
      }]
    },
    presentCall: (args) => ({
      card: "generic",
      title: `Read ${args.path}`,
      kind: "read",
      locations: [{ path: args.path }]
    }),
    async execute(args, exec) {
      const target = await resolveOfficePath(exec, args.path, [".docx"], true);
      const { buffer, sizeBytes } = await readOfficeBuffer(target.absolute, exec.signal);
      const zip = await loadZipGuarded(buffer, exec.signal);
      const documentXml = await readZipXmlPart(zip, "word/document.xml", exec.signal);
      if (documentXml === null) {
        throw new Error("the .docx has no word/document.xml part; is this a valid Word file?");
      }
      const fullText = args.format === "markdown" ? extractDocxMarkdown(documentXml) : extractDocxText(documentXml);
      const totalChars = fullText.length;
      const maxChars = Math.min(Math.max(args.max_chars ?? MAX_TEXT_CHARS, 1), MAX_TEXT_CHARS);
      const truncated = totalChars > maxChars;
      const text = truncated ? fullText.slice(0, maxChars) : fullText;
      return { path: target.display, text, totalChars, truncated, sizeBytes };
    }
  }));
}
function registerWordTools(ctx) {
  const disposeCreate = registerWordCreate(ctx);
  const disposeRead = registerWordRead(ctx);
  const disposeUpdate = registerWordUpdate(ctx);
  return () => {
    disposeCreate();
    disposeRead();
    disposeUpdate();
  };
}

// src/index.ts
var name = "dsh-office-tools";
var inject = ["tools"];
var Config = Schema.object({
  enablePptTools: Schema.boolean().default(true).description("register ppt_create / ppt_read (set to false to coexist with a dedicated PPT plugin such as dsh-ppt)")
});
function apply(ctx, config) {
  const resolved = Config(config ?? {});
  ctx.effect(() => {
    const disposers = [
      registerWordTools(ctx),
      registerExcelTools(ctx),
      ...resolved.enablePptTools ? [registerPptTools(ctx)] : []
    ];
    return () => disposers.forEach((dispose) => dispose());
  });
}
export {
  Config,
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map
