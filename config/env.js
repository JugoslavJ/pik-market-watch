"use strict";

// Shared validation for environment settings.

function integer(
  name,
  v,
  def,
  { min = 0, max = Number.MAX_SAFE_INTEGER } = {},
) {
  if (v == null || String(v).trim() === "") return def;
  const raw = String(v).trim();
  if (!/^[0-9]+$/.test(raw))
    throw new Error(
      `${name} must be an integer between ${min} and ${max}; received ${JSON.stringify(v)}`,
    );
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error(
      `${name} must be an integer between ${min} and ${max}; received ${JSON.stringify(v)}`,
    );
  return n;
}

function boolean(name, v, def) {
  if (v == null || String(v).trim() === "") return def;
  const raw = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(
    `${name} must be a boolean (1/0, true/false, yes/no, or on/off); received ${JSON.stringify(v)}`,
  );
}

module.exports = { integer, boolean };
