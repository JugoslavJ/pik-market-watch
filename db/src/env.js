"use strict";

function integer(
  name,
  value,
  defaultValue,
  { min = 0, max = Number.MAX_SAFE_INTEGER } = {},
) {
  if (value == null || String(value).trim() === "") return defaultValue;
  const raw = String(value).trim();
  const parsed = Number(raw);
  if (
    !/^[0-9]+$/.test(raw) ||
    !Number.isSafeInteger(parsed) ||
    parsed < min ||
    parsed > max
  )
    throw new Error(
      `${name} must be an integer between ${min} and ${max}; received ${JSON.stringify(value)}`,
    );
  return parsed;
}

function boolean(name, value, defaultValue) {
  if (value == null || String(value).trim() === "") return defaultValue;
  const raw = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(
    `${name} must be a boolean (1/0, true/false, yes/no, or on/off); received ${JSON.stringify(value)}`,
  );
}

module.exports = { integer, boolean };
